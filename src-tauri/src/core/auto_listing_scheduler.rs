use crate::core::db::{AutoListingSchedulerRecord, Database};
use crate::core::models::{
    AutoListingRequest, JobKind, JobStatus, LocalMockupRenderAssetInput, LocalMockupRenderRequest,
};
use crate::core::{commands, ozon::OzonSellerClient, secrets};
use crate::AppState;
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, FixedOffset, Local, NaiveDate, Timelike};
use reqwest::Method;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::Manager;
use tokio::sync::Notify;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShopScheduleState {
    pub local_shop_id: String,
    pub external_shop_id: String,
    pub quota_known: bool,
    pub create_remaining: u64,
    pub total_remaining: u64,
}

#[derive(Debug, Clone)]
pub struct SchedulerDecisionInput {
    pub now: DateTime<FixedOffset>,
    pub start_minute: u32,
    pub end_minute: u32,
    pub last_quota_date: Option<NaiveDate>,
    pub tick_in_progress: bool,
    pub paused: bool,
    pub shops: Vec<ShopScheduleState>,
    pub executing_run_id: Option<String>,
    pub waiting_run_ids: Vec<String>,
    pub checkpoint_run_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NoopReason {
    Paused,
    TickAlreadyRunning,
    OutsideWindow,
    NoEligibleShops,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchedulerAction {
    Noop(NoopReason),
    RefreshQuotas,
    RecoverRun {
        run_id: String,
    },
    ExecuteRun {
        run_id: String,
    },
    ReserveBatch {
        eligible_external_shop_ids: Vec<String>,
    },
}

pub fn decide_next_action(input: SchedulerDecisionInput) -> SchedulerAction {
    if input.paused {
        return SchedulerAction::Noop(NoopReason::Paused);
    }
    if input.tick_in_progress {
        return SchedulerAction::Noop(NoopReason::TickAlreadyRunning);
    }
    if let Some(run_id) = input.checkpoint_run_id {
        return SchedulerAction::RecoverRun { run_id };
    }
    if let Some(run_id) = input.executing_run_id {
        return SchedulerAction::ExecuteRun { run_id };
    }
    if let Some(run_id) = input.waiting_run_ids.into_iter().next() {
        return SchedulerAction::ExecuteRun { run_id };
    }
    if !is_within_execution_window(&input.now, input.start_minute, input.end_minute) {
        return SchedulerAction::Noop(NoopReason::OutsideWindow);
    }
    if input.last_quota_date != Some(input.now.date_naive()) {
        return SchedulerAction::RefreshQuotas;
    }
    let eligible_external_shop_ids = input
        .shops
        .into_iter()
        .filter(|shop| shop.quota_known && shop.create_remaining > 0 && shop.total_remaining > 0)
        .map(|shop| shop.external_shop_id)
        .collect::<Vec<_>>();
    if eligible_external_shop_ids.is_empty() {
        SchedulerAction::Noop(NoopReason::NoEligibleShops)
    } else {
        SchedulerAction::ReserveBatch {
            eligible_external_shop_ids,
        }
    }
}

fn is_terminal_run_status(status: &str) -> bool {
    matches!(status, "completed" | "failed")
}

fn should_prepare_assignment(status: &str) -> bool {
    matches!(status, "reserved" | "preparing")
}

fn resume_run_id<'a>(
    checkpoint_run_id: Option<&'a str>,
    executing_run_id: Option<&'a str>,
) -> Option<&'a str> {
    checkpoint_run_id.or(executing_run_id)
}

fn should_reconcile_submission_job(stage: Option<&str>, kind: JobKind) -> bool {
    stage == Some("submitting") && kind == JobKind::AutoListing
}

fn is_empty_auto_listing_batch_error(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("AUTO_LISTING_NO_NEW_ASSETS")
        || message.contains("\u{672c}\u{6279}\u{6b21}\u{7d20}\u{6750}\u{5747}\u{5df2}\u{5728}\u{5bf9}\u{5e94}\u{5e97}\u{94fa}\u{5b58}\u{5728}")
}

fn cloud_request_timeout(path: &str) -> Duration {
    if path == "/gallery/listing-batches" {
        Duration::from_secs(600)
    } else {
        Duration::from_secs(180)
    }
}

fn reusable_mockup_result_path(
    status: JobStatus,
    result_path: Option<String>,
    output_path: Option<String>,
) -> Option<String> {
    if status == JobStatus::Succeeded {
        result_path.or(output_path)
    } else {
        None
    }
}

fn is_within_execution_window(
    now: &DateTime<FixedOffset>,
    start_minute: u32,
    end_minute: u32,
) -> bool {
    let minute = now.hour() * 60 + now.minute();
    minute >= start_minute && minute < end_minute
}

const SESSION_PLAN_ID: &str = "__scheduler_session__";
const ACTIVE_TICK_INTERVAL: Duration = Duration::from_secs(5);
const IDLE_TICK_INTERVAL: Duration = Duration::from_secs(600);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunSchedulerRequest {
    pub account_id: String,
    pub cloud_api_base_url: String,
    pub cloud_auth_token: String,
    pub plan_id: Option<String>,
    #[serde(default = "default_true")]
    pub force: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatusRequest {
    pub account_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PauseSchedulerRequest {
    pub account_id: String,
    pub plan_id: String,
    #[serde(default = "default_true")]
    pub paused: bool,
}

fn default_scheduler_batch_size() -> u32 {
    20
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerStatus {
    pub account_id: String,
    pub tick_running: bool,
    pub plan_states: Vec<SchedulerPlanStatus>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerPlanStatus {
    pub plan_id: String,
    pub paused: bool,
    pub run_id: Option<String>,
    pub local_job_id: Option<String>,
    pub stage: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Clone)]
struct SchedulerSession {
    account_id: String,
    base_url: String,
    auth_token: String,
    auth_secret_key: String,
}

#[derive(Clone)]
pub struct AutoListingScheduler {
    db_path: PathBuf,
    http: reqwest::Client,
    sessions: Arc<Mutex<HashMap<String, SchedulerSession>>>,
    active_accounts: Arc<Mutex<HashSet<String>>>,
    wake: Arc<Notify>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudPlan {
    id: String,
    product_image_rule_id: String,
    mockup_template_id: String,
    mockup_template_name: String,
    title_prompt: String,
    start_minute: u32,
    end_minute: u32,
    enabled: bool,
    #[serde(default = "default_scheduler_batch_size")]
    batch_size: u32,
    #[serde(default)]
    updated_at: Option<String>,
    #[serde(default, deserialize_with = "deserialize_vec_or_default")]
    shop_configs: Vec<CloudPlanShop>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CloudPlanShop {
    external_shop_id: String,
    local_shop_id: String,
    shop_name: String,
    product_template_id: String,
    product_template_name: String,
    template_product: Value,
    auto_generate_barcode: bool,
    auto_update_stock: bool,
    auto_add_to_action: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudRun {
    id: String,
    status: String,
    #[serde(default, deserialize_with = "deserialize_vec_or_default")]
    assignments: Vec<CloudAssignment>,
}

fn deserialize_vec_or_default<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<Vec<T>>::deserialize(deserializer).map(Option::unwrap_or_default)
}

fn parse_top_level_vec<T>(value: Option<&Value>) -> Result<Vec<T>>
where
    T: for<'de> Deserialize<'de>,
{
    match value {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(value) => serde_json::from_value(value.clone()).context("浜戠鏁扮粍瀛楁鏍煎紡閿欒"),
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudAssignment {
    id: String,
    source_asset_id: String,
    external_shop_id: String,
    batch_id: Option<String>,
    status: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PlanTickOutcome {
    Wait,
    Continue,
    Advance,
}

fn has_unbatched_preparable_assignments(assignments: &[CloudAssignment]) -> bool {
    assignments.iter().any(|assignment| {
        assignment.batch_id.is_none() && should_prepare_assignment(&assignment.status)
    })
}
fn record_has_active_work(record: &AutoListingSchedulerRecord) -> bool {
    record.cloud_run_id.is_some()
        || record.local_job_id.is_some()
        || record.stage.is_some()
        || record
            .pending_progress
            .as_array()
            .is_some_and(|items| !items.is_empty())
}

fn order_plans_for_queue(
    mut plans: Vec<CloudPlan>,
    active_plan_id: Option<&str>,
    only_plan_id: Option<&str>,
) -> Vec<CloudPlan> {
    if let Some(only_plan_id) = only_plan_id {
        plans.retain(|plan| plan.enabled && plan.id == only_plan_id);
    } else {
        plans.retain(|plan| plan.enabled || active_plan_id == Some(plan.id.as_str()));
    }
    plans.sort_by(|left, right| {
        left.start_minute
            .cmp(&right.start_minute)
            .then_with(|| left.updated_at.cmp(&right.updated_at))
            .then_with(|| left.id.cmp(&right.id))
    });
    if let Some(active_plan_id) = active_plan_id {
        if let Some(index) = plans.iter().position(|plan| plan.id == active_plan_id) {
            let active_plan = plans.remove(index);
            plans.insert(0, active_plan);
        }
    }
    plans
}

#[cfg(test)]
fn ordered_plan_ids_for_queue(
    plans: Vec<CloudPlan>,
    active_plan_id: Option<&str>,
    only_plan_id: Option<&str>,
) -> Vec<String> {
    order_plans_for_queue(plans, active_plan_id, only_plan_id)
        .into_iter()
        .map(|plan| plan.id)
        .collect()
}

fn begin_new_run(record: &mut AutoListingSchedulerRecord, run_id: String) {
    record.cloud_run_id = Some(run_id);
    record.local_job_id = None;
    record.stage = None;
    record.last_error = None;
}

impl AutoListingScheduler {
    pub fn new(db_path: PathBuf) -> Self {
        let scheduler = Self {
            db_path,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(180))
                .build()
                .expect("scheduler HTTP client"),
            sessions: Arc::new(Mutex::new(HashMap::new())),
            active_accounts: Arc::new(Mutex::new(HashSet::new())),
            wake: Arc::new(Notify::new()),
        };
        scheduler.restore_sessions();
        scheduler
    }

    pub fn start(&self, app: tauri::AppHandle) {
        let scheduler = self.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                scheduler.tick_all(app.clone()).await;
                let interval = if scheduler.has_active_work() {
                    ACTIVE_TICK_INTERVAL
                } else {
                    IDLE_TICK_INTERVAL
                };
                tokio::select! {
                    _ = tokio::time::sleep(interval) => {},
                    _ = scheduler.wake.notified() => {},
                }
            }
        });
    }

    pub async fn resume_saved_session(
        &self,
        app: tauri::AppHandle,
        account_id: &str,
        plan_id: Option<&str>,
    ) -> Result<SchedulerStatus, String> {
        self.restore_sessions();
        if !self.sessions.lock().map_err(|_| "scheduler sessions poisoned".to_string())?.contains_key(account_id) {
            return Err("自动上品登录会话不存在，请重新登录云端账号".into());
        }
        self.tick_account(app, account_id, plan_id, true).await;
        self.status(account_id).map_err(|error| error.to_string())
    }

    pub async fn tick(
        &self,
        app: tauri::AppHandle,
        request: RunSchedulerRequest,
    ) -> Result<SchedulerStatus, String> {
        let account_id = request.account_id.clone();
        self.register_session(&request)
            .map_err(|error| error.to_string())?;
        self.tick_account(app, &account_id, request.plan_id.as_deref(), request.force)
            .await;
        self.status(&account_id).map_err(|error| error.to_string())
    }

    pub fn pause(&self, request: PauseSchedulerRequest) -> Result<SchedulerStatus, String> {
        let mut records = self.records().map_err(|error| error.to_string())?;
        let mut record = records
            .drain(..)
            .find(|item| item.account_id == request.account_id && item.plan_id == request.plan_id)
            .ok_or_else(|| "鑷姩涓婂搧鏂规灏氭湭鍦ㄦ湰鍦拌皟搴﹀櫒娉ㄥ唽".to_string())?;
        record.paused = request.paused;
        self.save_record(&record)
            .map_err(|error| error.to_string())?;
        self.wake.notify_one();
        self.status(&request.account_id)
            .map_err(|error| error.to_string())
    }

    pub fn status(&self, account_id: &str) -> Result<SchedulerStatus> {
        let tick_running = self
            .active_accounts
            .lock()
            .map_err(|_| anyhow!("scheduler lock poisoned"))?
            .contains(account_id);
        let plan_states = self
            .records()?
            .into_iter()
            .filter(|item| item.account_id == account_id && item.plan_id != SESSION_PLAN_ID)
            .map(|item| SchedulerPlanStatus {
                plan_id: item.plan_id,
                paused: item.paused,
                run_id: item.cloud_run_id,
                local_job_id: item.local_job_id,
                stage: item.stage,
                last_error: item.last_error,
            })
            .collect();
        Ok(SchedulerStatus {
            account_id: account_id.to_string(),
            tick_running,
            plan_states,
        })
    }

    fn restore_sessions(&self) {
        let Ok(records) = self.records() else {
            return;
        };
        let mut sessions = self.sessions.lock().expect("scheduler sessions poisoned");
        for record in records {
            if sessions.contains_key(&record.account_id) {
                continue;
            }
            if let Ok(auth_token) = secrets::get_secret(&record.auth_secret_key) {
                sessions.insert(
                    record.account_id.clone(),
                    SchedulerSession {
                        account_id: record.account_id,
                        base_url: record.cloud_api_base_url,
                        auth_token,
                        auth_secret_key: record.auth_secret_key,
                    },
                );
            }
        }
    }

    fn register_session(&self, request: &RunSchedulerRequest) -> Result<()> {
        let auth_secret_key = format!("cloud:auto-listing:{}:token", request.account_id);
        secrets::set_secret(&auth_secret_key, &request.cloud_auth_token)?;
        let session = SchedulerSession {
            account_id: request.account_id.clone(),
            base_url: request.cloud_api_base_url.trim_end_matches('/').to_string(),
            auth_token: request.cloud_auth_token.clone(),
            auth_secret_key: auth_secret_key.clone(),
        };
        self.sessions
            .lock()
            .map_err(|_| anyhow!("scheduler sessions poisoned"))?
            .insert(request.account_id.clone(), session.clone());
        self.save_record(&AutoListingSchedulerRecord {
            account_id: session.account_id,
            plan_id: SESSION_PLAN_ID.into(),
            cloud_api_base_url: session.base_url,
            auth_secret_key,
            paused: false,
            last_quota_date: None,
            cloud_run_id: None,
            local_job_id: None,
            stage: None,
            pending_progress: json!([]),
            last_error: None,
        })
    }

    async fn tick_all(&self, app: tauri::AppHandle) {
        let account_ids = self
            .sessions
            .lock()
            .map(|items| items.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for account_id in account_ids {
            self.tick_account(app.clone(), &account_id, None, false)
                .await;
        }
    }

    async fn tick_account(
        &self,
        app: tauri::AppHandle,
        account_id: &str,
        only_plan_id: Option<&str>,
        force: bool,
    ) {
        {
            let Ok(mut active) = self.active_accounts.lock() else {
                return;
            };
            if !active.insert(account_id.to_string()) {
                return;
            }
        }
        if let Err(error) = self
            .tick_account_inner(app, account_id, only_plan_id, force)
            .await
        {
            eprintln!("鑷姩涓婂搧璋冨害澶辫触: {error}");
        }
        if let Ok(mut active) = self.active_accounts.lock() {
            active.remove(account_id);
        }
    }

    async fn tick_account_inner(
        &self,
        app: tauri::AppHandle,
        account_id: &str,
        only_plan_id: Option<&str>,
        force: bool,
    ) -> Result<()> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| anyhow!("scheduler sessions poisoned"))?
            .get(account_id)
            .cloned()
            .ok_or_else(|| anyhow!("scheduler session missing"))?;
        let plans_value = self
            .cloud(&session, Method::GET, "/gallery/auto-listing/plans", None)
            .await?;
        let plans: Vec<CloudPlan> =
            parse_top_level_vec(plans_value.get("plans")).context("瑙ｆ瀽鑷姩涓婂搧鏂规澶辫触")?;
        let active_plan_id = if only_plan_id.is_none() {
            self.records()?
                .into_iter()
                .filter(|record| {
                    record.account_id == session.account_id
                        && record.plan_id != SESSION_PLAN_ID
                        && record_has_active_work(record)
                })
                .map(|record| record.plan_id)
                .min()
        } else {
            None
        };
        let plans = order_plans_for_queue(plans, active_plan_id.as_deref(), only_plan_id);
        let mut plan_index = 0;
        while plan_index < plans.len() {
            let plan = plans[plan_index].clone();
            let plan_id = plan.id.clone();
            match self.process_plan(app.clone(), &session, plan, force).await {
                Ok(PlanTickOutcome::Wait) => break,
                Ok(PlanTickOutcome::Continue) => {}
                Ok(PlanTickOutcome::Advance) => {
                    plan_index += 1;
                }
                Err(error) => {
                    self.record_error(&session, &plan_id, &format!("{error:#}"));
                    if self.plan_has_active_work(&session.account_id, &plan_id)? {
                        break;
                    }
                    plan_index += 1;
                }
            }
        }
        Ok(())
    }

    async fn process_plan(
        &self,
        app: tauri::AppHandle,
        session: &SchedulerSession,
        plan: CloudPlan,
        force: bool,
    ) -> Result<PlanTickOutcome> {
        let mut record = self
            .records()?
            .into_iter()
            .find(|item| item.account_id == session.account_id && item.plan_id == plan.id)
            .unwrap_or(AutoListingSchedulerRecord {
                account_id: session.account_id.clone(),
                plan_id: plan.id.clone(),
                cloud_api_base_url: session.base_url.clone(),
                auth_secret_key: session.auth_secret_key.clone(),
                paused: false,
                last_quota_date: None,
                cloud_run_id: None,
                local_job_id: None,
                stage: None,
                pending_progress: json!([]),
                last_error: None,
            });
        if record.paused && !force {
            return Ok(PlanTickOutcome::Advance);
        }
        let now = Local::now().fixed_offset();
        self.flush_pending_progress(session, &mut record).await?;
        let runs_value = self
            .cloud(
                session,
                Method::GET,
                &format!(
                    "/gallery/auto-listing/runs?planId={}&limit=20&compact=true",
                    plan.id
                ),
                None,
            )
            .await?;
        let runs: Vec<CloudRun> =
            parse_top_level_vec(runs_value.get("runs")).context("瑙ｆ瀽鑷姩涓婂搧杩愯璁板綍澶辫触")?;
        let executing = runs
            .iter()
            .find(|run| matches!(run.status.as_str(), "preparing" | "submitting"));
        if let Some(run_id) = resume_run_id(
            record.cloud_run_id.as_deref(),
            executing.map(|run| run.id.as_str()),
        ) {
            if let Some(run) = runs.iter().find(|run| run.id == run_id) {
                if is_terminal_run_status(&run.status) {
                    record.cloud_run_id = None;
                    record.local_job_id = None;
                    record.stage = None;
                    record.last_error = None;
                    self.save_record(&record)?;
                    return Ok(PlanTickOutcome::Continue);
                }
                record.last_quota_date = Some(Local::now().date_naive().to_string());
                self.save_record(&record)?;
                self.execute_run(app, session, &plan, run.clone(), &mut record)
                    .await?;
                return Ok(if record_has_active_work(&record) {
                    PlanTickOutcome::Wait
                } else {
                    PlanTickOutcome::Continue
                });
            }
            record.cloud_run_id = None;
            record.local_job_id = None;
            record.stage = None;
            self.save_record(&record)?;
        }
        let waiting = runs.iter().find(|run| run.status == "waiting");
        if let Some(run) = waiting {
            record.last_quota_date = Some(Local::now().date_naive().to_string());
            self.save_record(&record)?;
            self.execute_run(app, session, &plan, run.clone(), &mut record)
                .await?;
            return Ok(if record_has_active_work(&record) {
                PlanTickOutcome::Wait
            } else {
                PlanTickOutcome::Continue
            });
        }
        if !force && !is_within_execution_window(&now, plan.start_minute, plan.end_minute) {
            record.last_error = None;
            self.save_record(&record)?;
            return Ok(PlanTickOutcome::Advance);
        }
        let mut shops = Vec::new();
        let mut quota_json = serde_json::Map::new();
        for config in &plan.shop_configs {
            match self.shop_quota(&app, &config.local_shop_id).await {
                Ok(quota) => {
                    shops.push(ShopScheduleState {
                        local_shop_id: config.local_shop_id.clone(),
                        external_shop_id: config.external_shop_id.clone(),
                        quota_known: true,
                        create_remaining: quota.daily_create_remaining,
                        total_remaining: quota.total_remaining,
                    });
                    quota_json.insert(
                        config.external_shop_id.clone(),
                        serde_json::to_value(quota)?,
                    );
                }
                Err(_) => shops.push(ShopScheduleState {
                    local_shop_id: config.local_shop_id.clone(),
                    external_shop_id: config.external_shop_id.clone(),
                    quota_known: false,
                    create_remaining: 0,
                    total_remaining: 0,
                }),
            }
        }
        let action = decide_next_action(SchedulerDecisionInput {
            now,
            start_minute: if force { 0 } else { plan.start_minute },
            end_minute: if force { 24 * 60 } else { plan.end_minute },
            last_quota_date: Some(Local::now().date_naive()),
            tick_in_progress: false,
            paused: record.paused && !force,
            shops,
            executing_run_id: executing.map(|run| run.id.clone()),
            waiting_run_ids: waiting.map(|run| vec![run.id.clone()]).unwrap_or_default(),
            checkpoint_run_id: record.cloud_run_id.clone(),
        });
        record.last_quota_date = Some(Local::now().date_naive().to_string());
        self.save_record(&record)?;
        match action {
            SchedulerAction::RecoverRun { run_id } | SchedulerAction::ExecuteRun { run_id } => {
                if let Some(run) = runs.iter().find(|run| run.id == run_id) {
                    self.execute_run(app, session, &plan, run.clone(), &mut record)
                        .await?;
                    if record_has_active_work(&record) {
                        return Ok(PlanTickOutcome::Wait);
                    }
                    return Ok(PlanTickOutcome::Continue);
                } else {
                    record.cloud_run_id = None;
                    record.local_job_id = None;
                    record.stage = None;
                    self.save_record(&record)?;
                    return Ok(PlanTickOutcome::Continue);
                }
            }
            SchedulerAction::ReserveBatch { .. } => {
                let reserved = self
                    .cloud(
                        session,
                        Method::POST,
                        "/gallery/auto-listing/reservations",
                        Some(json!({"planId": plan.id, "quotaByExternalShopId": quota_json})),
                    )
                    .await?;
                let run: CloudRun = serde_json::from_value(
                    json!({"id": reserved["run"]["id"], "status": reserved["run"]["status"], "assignments": reserved["assignments"]}),
                )?;
                if !run.assignments.is_empty() {
                    begin_new_run(&mut record, run.id.clone());
                    self.save_record(&record)?;
                    self.execute_run(app, session, &plan, run, &mut record)
                        .await?;
                    return Ok(if record_has_active_work(&record) {
                        PlanTickOutcome::Wait
                    } else {
                        PlanTickOutcome::Continue
                    });
                }
                return Ok(PlanTickOutcome::Advance);
            }
            _ => return Ok(PlanTickOutcome::Advance),
        }
    }

    async fn execute_run(
        &self,
        app: tauri::AppHandle,
        session: &SchedulerSession,
        plan: &CloudPlan,
        run: CloudRun,
        record: &mut AutoListingSchedulerRecord,
    ) -> Result<()> {
        if !has_unbatched_preparable_assignments(&run.assignments) {
            if let Some(batch_id) = run
                .assignments
                .iter()
                .find_map(|item| item.batch_id.clone())
            {
            return self
                    .start_or_reconcile_batch(app, session, plan, &run, &batch_id, record)
                    .await;
            }
        }
        let reserved = run
            .assignments
            .iter()
            .filter(|item| should_prepare_assignment(&item.status))
            .take(plan.batch_size.max(1) as usize)
            .cloned()
            .collect::<Vec<_>>();
        if reserved.is_empty() {
            return Ok(());
        }
        let checkpoint_matches_run = record.cloud_run_id.as_deref() == Some(run.id.as_str());
        let state = app.state::<AppState>();
        let reusable_result_path = checkpoint_matches_run
            .then(|| record.local_job_id.as_ref())
            .flatten()
            .and_then(|job_id| {
                state
                    .jobs
                    .list_jobs()
                    .into_iter()
                    .find(|item| &item.id == job_id)
            })
            .and_then(|job| {
                reusable_mockup_result_path(job.status, job.result_path, job.output_path)
            });
        record.cloud_run_id = Some(run.id.clone());
        record.stage = Some("preparing".into());
        self.save_record(record)?;
        self.push_progress(
            session,
            record,
            reserved
                .iter()
                .map(|item| json!({"assignmentId":item.id,"status":"preparing"}))
                .collect(),
        )
        .await?;
        let result = if let Some(result_path) = reusable_result_path {
            commands::read_local_mockup_result(result_path).map_err(anyhow::Error::msg)?
        } else {
            let job = commands::start_local_mockup_render(
                app.clone(),
                state,
                LocalMockupRenderRequest {
                    cloud_api_base_url: Some(session.base_url.clone()),
                    cloud_auth_token: Some(session.auth_token.clone()),
                    template_id: plan.mockup_template_id.clone(),
                    template_name: Some(plan.mockup_template_name.clone()),
                    assets: reserved
                        .iter()
                        .map(|item| LocalMockupRenderAssetInput {
                            id: item.source_asset_id.clone(),
                            sku: item.source_asset_id.clone(),
                            source_filename: None,
                            public_url: None,
                        })
                        .collect(),
                    max_workers: None,
                },
            )
            .map_err(anyhow::Error::msg)?;
            record.local_job_id = Some(job.id.clone());
            self.save_record(record)?;
            loop {
                let current = app
                    .state::<AppState>()
                    .jobs
                    .list_jobs()
                    .into_iter()
                    .find(|item| item.id == job.id)
                    .ok_or_else(|| anyhow!("mockup job missing"))?;
                match current.status {
                    JobStatus::Succeeded => {
                        break commands::read_local_mockup_result(
                            current
                                .result_path
                                .or(current.output_path)
                                .ok_or_else(|| anyhow!("濂楀浘缁撴灉璺緞缂哄け"))?,
                        )
                        .map_err(anyhow::Error::msg)?
                    }
                    JobStatus::Failed | JobStatus::Cancelled => {
                        return Err(anyhow!(current
                            .last_error
                            .or(current.error)
                            .unwrap_or_else(|| "濂楀浘澶辫触".into())))
                    }
                    _ => tokio::time::sleep(Duration::from_secs(1)).await,
                }
            }
        };
        let mut assets = Vec::new();
        let mut successful_assignment_ids = HashSet::new();
        let mut failed_updates = Vec::new();
        for assignment in &reserved {
            let Some(item) = result.items.iter().find(|item| {
                item.source_asset_id == assignment.source_asset_id
                    && item.ok
                    && !item.assets.is_empty()
            }) else {
                failed_updates.push(
                    json!({"assignmentId":assignment.id,"status":"failed","lastError":"濂楀浘澶辫触"}),
                );
                continue;
            };
            let Some(image_id) = item.assets[0].get("id").and_then(Value::as_str) else {
                failed_updates.push(json!({"assignmentId":assignment.id,"status":"failed","lastError":"濂楀浘缁撴灉缂哄皯璧勪骇 ID"}));
                continue;
            };
            let title_result = self.cloud(session, Method::POST, "/gallery/titles/generate", Some(json!({"sourceAssetId":assignment.source_asset_id,"imageAssetId":image_id,"prompt":plan.title_prompt}))).await;
            let Ok(title_value) = title_result else {
                failed_updates.push(json!({"assignmentId":assignment.id,"status":"failed","lastError":"鏍囬鐢熸垚澶辫触"}));
                continue;
            };
            let title = title_value["title"]
                .as_str()
                .unwrap_or_default()
                .trim()
                .to_string();
            if title.is_empty() {
                failed_updates.push(
                    json!({"assignmentId":assignment.id,"status":"failed","lastError":"鏍囬涓虹┖"}),
                );
                continue;
            }
            assets.push(json!({"sourceAssetId":assignment.source_asset_id,"externalShopId":assignment.external_shop_id,"imageAssetIds":item.assets.iter().filter_map(|asset| asset.get("id").and_then(Value::as_str)).collect::<Vec<_>>(),"title":title}));
            successful_assignment_ids.insert(assignment.id.clone());
        }
        if !failed_updates.is_empty() {
            self.push_progress(session, record, failed_updates).await?;
        }
        if assets.is_empty() {
            return Err(anyhow!("预留批次没有可执行素材"));
        }
        let shop_targets = plan.shop_configs.iter().filter(|shop| assets.iter().any(|asset| asset["externalShopId"] == shop.external_shop_id)).map(|shop| json!({"externalShopId":shop.external_shop_id,"id":shop.product_template_id,"name":shop.product_template_name,"configSnapshot":shop})).collect::<Vec<_>>();
        let batch_value = match self.cloud(session, Method::POST, "/gallery/listing-batches", Some(json!({"productImageRuleId":plan.product_image_rule_id,"mockupTemplateId":plan.mockup_template_id,"mockupTemplateName":plan.mockup_template_name,"titlePrompt":plan.title_prompt,"autoListingRunId":run.id,"shopTargets":shop_targets,"assets":assets}))).await {
            Ok(value) => value,
            Err(error) if is_empty_auto_listing_batch_error(&error) => {
                record.local_job_id = None;
                record.stage = None;
                record.last_error = None;
                self.save_record(record)?;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        let batch = batch_value["batch"].clone();
        let accepted_source_asset_ids = batch["imageSets"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["sourceAssetId"].as_str())
            .collect::<HashSet<_>>();
        successful_assignment_ids.retain(|assignment_id| {
            reserved
                .iter()
                .find(|assignment| assignment.id == *assignment_id)
                .is_some_and(|assignment| accepted_source_asset_ids.contains(assignment.source_asset_id.as_str()))
        });
        if successful_assignment_ids.is_empty() {
            record.local_job_id = None;
            record.stage = None;
            self.save_record(record)?;
            return Ok(());
        }
        let batch_id = batch["id"]
            .as_str()
            .ok_or_else(|| anyhow!("listing batch id missing"))?
            .to_string();
        self.push_progress(
            session,
            record,
            reserved
                .iter()
                .filter(|item| successful_assignment_ids.contains(&item.id))
                .map(|item| json!({"assignmentId":item.id,"status":"ready","batchId":batch_id}))
                .collect(),
        )
        .await?;
        let mut batch_run = run.clone();
        batch_run
            .assignments
            .retain(|item| successful_assignment_ids.contains(&item.id));
        for assignment in &mut batch_run.assignments {
            assignment.batch_id = Some(batch_id.clone());
        }
        self.start_or_reconcile_batch(app, session, plan, &batch_run, &batch_id, record)
            .await
    }

    async fn start_or_reconcile_batch(
        &self,
        app: tauri::AppHandle,
        session: &SchedulerSession,
        plan: &CloudPlan,
        run: &CloudRun,
        batch_id: &str,
        record: &mut AutoListingSchedulerRecord,
    ) -> Result<()> {
        let batch_assignments = run
            .assignments
            .iter()
            .filter(|item| item.batch_id.as_deref() == Some(batch_id))
            .collect::<Vec<_>>();
        if batch_assignments.is_empty() {
            return Ok(());
        }
        let batch = self
            .cloud(
                session,
                Method::GET,
                &format!("/gallery/listing-batches/{batch_id}"),
                None,
            )
            .await?["batch"]
            .clone();
        if let Some(job_id) = &record.local_job_id {
            if let Some(job) = app
                .state::<AppState>()
                .jobs
                .list_jobs()
                .into_iter()
                .find(|item| &item.id == job_id)
                .filter(|job| should_reconcile_submission_job(record.stage.as_deref(), job.kind))
            {
                match job.status {
                    JobStatus::Succeeded => {
                        let image_sets = batch["imageSets"].as_array().cloned().unwrap_or_default();
                        self.push_progress(
                            session,
                            record,
                            batch_assignments
                                .iter()
                                .map(|item| {
                                    let completed = image_sets.iter().any(|image| {
                                        image["sourceAssetId"] == item.source_asset_id
                                            && (!image["completedAt"].is_null()
                                                || !image["productId"].is_null())
                                    });
                                    if completed {
                                        json!({"assignmentId":item.id,"status":"completed"})
                                    } else {
                                        json!({"assignmentId":item.id,"status":"failed","lastError":"Ozon 提交未完成"})
                                    }
                                })
                                .collect(),
                        )
                        .await?;
                        record.cloud_run_id = None;
                        record.local_job_id = None;
                        record.stage = None;
                        record.last_error = None;
                        self.save_record(record)?;
                        return Ok(());
                    }
                    JobStatus::Queued | JobStatus::Running => return Ok(()),
                    _ => {}
                }
            }
        }
        let request = build_auto_listing_request(session, plan, &batch)?;
        let job = commands::start_auto_listing(app.state::<AppState>(), request)
            .map_err(anyhow::Error::msg)?;
        record.cloud_run_id = Some(run.id.clone());
        record.local_job_id = Some(job.id.clone());
        record.stage = Some("submitting".into());
        record.last_error = None;
        self.save_record(record)?;
        self.push_progress(
            session,
            record,
            batch_assignments
                .into_iter()
                .map(
                    |item| json!({"assignmentId":item.id,"status":"submitting","batchId":batch_id}),
                )
                .collect(),
        )
        .await
    }

    async fn push_progress(
        &self,
        session: &SchedulerSession,
        record: &mut AutoListingSchedulerRecord,
        updates: Vec<Value>,
    ) -> Result<()> {
        record.pending_progress = Value::Array(updates.clone());
        self.save_record(record)?;
        for chunk in updates.chunks(200) {
            self.cloud(
                session,
                Method::POST,
                "/gallery/auto-listing/assignments/progress",
                Some(json!({"updates":chunk})),
            )
            .await?;
        }
        record.pending_progress = json!([]);
        self.save_record(record)
    }
    async fn flush_pending_progress(
        &self,
        session: &SchedulerSession,
        record: &mut AutoListingSchedulerRecord,
    ) -> Result<()> {
        if record
            .pending_progress
            .as_array()
            .is_some_and(|items| !items.is_empty())
        {
            let updates = record.pending_progress.as_array().cloned().unwrap_or_default();
            for chunk in updates.chunks(200) {
                self.cloud(
                    session,
                    Method::POST,
                    "/gallery/auto-listing/assignments/progress",
                    Some(json!({"updates":chunk})),
                )
                .await?;
            }
            record.pending_progress = json!([]);
            self.save_record(record)?;
        }
        Ok(())
    }
    async fn shop_quota(
        &self,
        app: &tauri::AppHandle,
        shop_id: &str,
    ) -> Result<crate::core::ozon::OzonUploadQuota> {
        let (client_id, key) = {
            let state = app.state::<AppState>();
            let db = state.db.lock().map_err(|_| anyhow!("database locked"))?;
            let shop = db.get_shop(shop_id)?;
            (shop.client_id, db.shop_api_key(shop_id)?)
        };
        OzonSellerClient::new(client_id, key)?
            .product_upload_quota()
            .await
    }
    async fn cloud(
        &self,
        session: &SchedulerSession,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value> {
        let mut request = self
            .http
            .request(method, format!("{}{}", session.base_url, path))
            .timeout(cloud_request_timeout(path))
            .bearer_auth(&session.auth_token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request.send().await?;
        let status = response.status();
        let value = response.json::<Value>().await.unwrap_or_default();
        if !status.is_success() {
            let message = value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("cloud request failed")
                .to_string();
            return Err(anyhow!(message));
        }
        Ok(value)
    }
    fn records(&self) -> Result<Vec<AutoListingSchedulerRecord>> {
        Database::open_at(self.db_path.clone())?.list_auto_listing_scheduler_states()
    }
    fn has_active_work(&self) -> bool {
        self.records()
            .map(|records| {
                records
                    .into_iter()
                    .filter(|record| record.plan_id != SESSION_PLAN_ID)
                    .any(|record| record_has_active_work(&record))
            })
            .unwrap_or(false)
    }
    fn plan_has_active_work(&self, account_id: &str, plan_id: &str) -> Result<bool> {
        Ok(self
            .records()?
            .into_iter()
            .find(|record| record.account_id == account_id && record.plan_id == plan_id)
            .is_some_and(|record| record_has_active_work(&record)))
    }
    fn save_record(&self, record: &AutoListingSchedulerRecord) -> Result<()> {
        Database::open_at(self.db_path.clone())?.save_auto_listing_scheduler_state(record)
    }
    fn record_error(&self, session: &SchedulerSession, plan_id: &str, message: &str) {
        if plan_id.is_empty() {
            return;
        }
        if let Ok(mut record) = self.records().and_then(|items| {
            items
                .into_iter()
                .find(|item| item.account_id == session.account_id && item.plan_id == plan_id)
                .ok_or_else(|| anyhow!("missing"))
        }) {
            record.last_error = Some(message.to_string());
            let _ = self.save_record(&record);
        }
    }
}

fn build_auto_listing_request(
    session: &SchedulerSession,
    plan: &CloudPlan,
    batch: &Value,
) -> Result<AutoListingRequest> {
    let image_sets = batch["imageSets"]
        .as_array()
        .ok_or_else(|| anyhow!("listing batch imageSets missing"))?;
    let external_ids = image_sets
        .iter()
        .filter_map(|item| item["externalShopId"].as_str())
        .collect::<HashSet<_>>();
    let shops = plan
        .shop_configs
        .iter()
        .filter(|shop| external_ids.contains(shop.external_shop_id.as_str()))
        .collect::<Vec<_>>();
    serde_json::from_value(json!({"batchId":batch["id"],"cloudApiBaseUrl":session.base_url,"cloudAuthToken":session.auth_token,"cloudExternalShopIdByShopId":shops.iter().map(|shop|(shop.local_shop_id.clone(),shop.external_shop_id.clone())).collect::<HashMap<_,_>>(),"mockupTemplateId":batch["mockupTemplateId"],"mockupTemplateName":batch["mockupTemplateName"],"items":image_sets.iter().filter(|item|item["completedAt"].is_null()).map(|item|json!({"sourceAssetId":item["sourceAssetId"],"sourceSku":item["sourceSku"],"shopId":shops.iter().find(|shop|item["externalShopId"]==shop.external_shop_id).map(|shop|shop.local_shop_id.as_str()).unwrap_or_default(),"title":item["title"],"imageUrls":item["imageUrls"]})).collect::<Vec<_>>(),"shopConfigs":shops.iter().map(|shop|json!({"shopId":shop.local_shop_id,"templateProduct":shop.template_product,"templateVideoLinks":[],"uploadTemplateVideo":false,"autoGenerateBarcode":shop.auto_generate_barcode,"autoUpdateStock":shop.auto_update_stock,"autoAddToAction":shop.auto_add_to_action,"postListingDelayMinutes":0,"actionDelayMinutes":0,"actionRetryCount":1,"actionRetryIntervalMinutes":10})).collect::<Vec<_>>() })).context("鑷姩涓婂搧璇锋眰鏋勫缓澶辫触")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{FixedOffset, TimeZone};

    fn plan(id: &str, start_minute: u32, updated_at: &str) -> CloudPlan {
        CloudPlan {
            id: id.into(),
            product_image_rule_id: "rule-a".into(),
            mockup_template_id: "mockup-a".into(),
            mockup_template_name: "Mockup".into(),
            title_prompt: "Title".into(),
            start_minute,
            end_minute: 22 * 60,
            enabled: true,
            batch_size: 20,
            updated_at: Some(updated_at.into()),
            shop_configs: Vec::new(),
        }
    }

    fn at(day: u32, hour: u32, minute: u32) -> chrono::DateTime<FixedOffset> {
        FixedOffset::east_opt(8 * 60 * 60)
            .unwrap()
            .with_ymd_and_hms(2026, 7, day, hour, minute, 0)
            .unwrap()
    }

    fn input(now: chrono::DateTime<FixedOffset>) -> SchedulerDecisionInput {
        SchedulerDecisionInput {
            now,
            start_minute: 8 * 60,
            end_minute: 22 * 60,
            last_quota_date: Some(now.date_naive()),
            tick_in_progress: false,
            paused: false,
            shops: vec![ShopScheduleState {
                local_shop_id: "local-a".into(),
                external_shop_id: "external-a".into(),
                quota_known: true,
                create_remaining: 10,
                total_remaining: 10,
            }],
            executing_run_id: None,
            waiting_run_ids: Vec::new(),
            checkpoint_run_id: None,
        }
    }

    #[test]
    fn new_run_clears_previous_local_job_checkpoint() {
        let mut record = AutoListingSchedulerRecord {
            account_id: "account-a".into(),
            plan_id: "plan-a".into(),
            cloud_api_base_url: "https://api.example.com".into(),
            auth_secret_key: "secret-a".into(),
            paused: false,
            last_quota_date: Some("2026-07-31".into()),
            cloud_run_id: Some("run-old".into()),
            local_job_id: Some("mockup-old".into()),
            stage: Some("preparing".into()),
            pending_progress: json!([]),
            last_error: Some("previous error".into()),
        };

        begin_new_run(&mut record, "run-new".into());

        assert_eq!(record.cloud_run_id.as_deref(), Some("run-new"));
        assert_eq!(record.local_job_id, None);
        assert_eq!(record.stage, None);
        assert_eq!(record.last_error, None);
    }

    #[test]
    fn outside_window_does_nothing() {
        let decision = decide_next_action(input(at(28, 7, 59)));
        assert_eq!(decision, SchedulerAction::Noop(NoopReason::OutsideWindow));
    }

    #[test]
    fn checkpoint_recovery_ignores_listing_window() {
        let mut state = input(at(28, 22, 30));
        state.checkpoint_run_id = Some("run-checkpoint".into());
        assert_eq!(
            decide_next_action(state),
            SchedulerAction::RecoverRun {
                run_id: "run-checkpoint".into(),
            }
        );
    }

    #[test]
    fn executing_run_recovery_ignores_listing_window() {
        let mut state = input(at(28, 22, 30));
        state.executing_run_id = Some("run-executing".into());
        assert_eq!(
            decide_next_action(state),
            SchedulerAction::ExecuteRun {
                run_id: "run-executing".into(),
            }
        );
    }

    #[test]
    fn scheduler_request_defaults_to_force_and_accepts_scheduled_mode() {
        let forced: RunSchedulerRequest = serde_json::from_value(json!({
            "accountId": "account-a",
            "cloudApiBaseUrl": "https://api.example.com",
            "cloudAuthToken": "token-a"
        }))
        .unwrap();
        assert!(forced.force);

        let scheduled: RunSchedulerRequest = serde_json::from_value(json!({
            "accountId": "account-a",
            "cloudApiBaseUrl": "https://api.example.com",
            "cloudAuthToken": "token-a",
            "force": false
        }))
        .unwrap();
        assert!(!scheduled.force);
    }

    #[test]
    fn daily_queue_orders_plans_and_keeps_active_plan_first() {
        let plans = vec![
            plan("plan-b", 600, "2026-07-30T00:02:00Z"),
            plan("plan-a", 480, "2026-07-30T00:03:00Z"),
            plan("plan-c", 600, "2026-07-30T00:01:00Z"),
        ];

        assert_eq!(
            ordered_plan_ids_for_queue(plans.clone(), None, None),
            vec!["plan-a", "plan-c", "plan-b"],
        );
        assert_eq!(
            ordered_plan_ids_for_queue(plans, Some("plan-b"), None),
            vec!["plan-b", "plan-a", "plan-c"],
        );
    }

    #[test]
    fn cloud_run_treats_null_assignments_as_empty() {
        let run: CloudRun = serde_json::from_value(json!({
            "id": "run-a",
            "status": "submitting",
            "assignments": null
        }))
        .unwrap();

        assert!(run.assignments.is_empty());
    }


    #[test]
    fn top_level_cloud_arrays_treat_missing_and_null_as_empty() {
        let missing: Vec<CloudRun> = parse_top_level_vec(None).unwrap();
        let null: Vec<CloudRun> = parse_top_level_vec(Some(&Value::Null)).unwrap();

        assert!(missing.is_empty());
        assert!(null.is_empty());
    }
    #[test]
    fn cloud_plan_treats_null_shop_configs_as_empty() {
        let plan: CloudPlan = serde_json::from_value(json!({
            "id": "plan-a",
            "productImageRuleId": "rule-a",
            "mockupTemplateId": "mockup-a",
            "mockupTemplateName": "Mockup",
            "titlePrompt": "Title",
            "startMinute": 480,
            "endMinute": 1320,
            "enabled": true,
            "shopConfigs": null
        }))
        .unwrap();

        assert!(plan.shop_configs.is_empty());
    }

    #[test]
    fn date_rollover_refreshes_quota_before_planning() {
        let mut state = input(at(29, 8, 0));
        state.last_quota_date = Some(at(28, 8, 0).date_naive());
        assert_eq!(decide_next_action(state), SchedulerAction::RefreshQuotas);
    }

    #[test]
    fn active_tick_blocks_a_second_tick_for_the_account() {
        let mut state = input(at(28, 9, 0));
        state.tick_in_progress = true;
        assert_eq!(
            decide_next_action(state),
            SchedulerAction::Noop(NoopReason::TickAlreadyRunning)
        );
    }

    #[test]
    fn reserve_excludes_shops_with_unknown_quota() {
        let mut state = input(at(28, 9, 0));
        state.shops.push(ShopScheduleState {
            local_shop_id: "local-b".into(),
            external_shop_id: "external-b".into(),
            quota_known: false,
            create_remaining: 0,
            total_remaining: 0,
        });
        assert_eq!(
            decide_next_action(state),
            SchedulerAction::ReserveBatch {
                eligible_external_shop_ids: vec!["external-a".into()],
            }
        );
    }

    #[test]
    fn checkpoint_run_is_resumed_before_quota_refresh() {
        assert_eq!(
            resume_run_id(Some("run-checkpoint"), Some("run-executing")),
            Some("run-checkpoint"),
        );
        assert_eq!(
            resume_run_id(None, Some("run-executing")),
            Some("run-executing"),
        );
        assert_eq!(resume_run_id(None, None), None);
    }

    #[test]
    fn executing_batch_is_resumed_before_another_batch_is_reserved() {
        let mut state = input(at(28, 9, 0));
        state.executing_run_id = Some("run-active".into());
        state.waiting_run_ids = vec!["run-waiting".into()];
        assert_eq!(
            decide_next_action(state),
            SchedulerAction::ExecuteRun {
                run_id: "run-active".into(),
            }
        );
    }

    #[test]
    fn preparing_assignments_are_resumable_after_batch_request_failure() {
        assert!(should_prepare_assignment("reserved"));
        assert!(should_prepare_assignment("preparing"));
        assert!(!should_prepare_assignment("ready"));
    }

    #[test]
    fn local_mockup_job_is_not_treated_as_ozon_submission() {
        assert!(!should_reconcile_submission_job(
            Some("preparing"),
            JobKind::LocalMockup,
        ));
        assert!(should_reconcile_submission_job(
            Some("submitting"),
            JobKind::AutoListing,
        ));
    }

    #[test]
    fn completed_mockup_job_result_is_reused_after_retry() {
        assert_eq!(
            reusable_mockup_result_path(
                JobStatus::Succeeded,
                Some("result.json".into()),
                Some("output.json".into()),
            ),
            Some("result.json".into()),
        );
        assert_eq!(
            reusable_mockup_result_path(JobStatus::Succeeded, None, Some("output.json".into()),),
            Some("output.json".into()),
        );
        assert_eq!(
            reusable_mockup_result_path(
                JobStatus::Failed,
                Some("result.json".into()),
                Some("output.json".into()),
            ),
            None,
        );
    }

    #[test]
    fn listing_batch_creation_uses_extended_timeout() {
        assert_eq!(
            cloud_request_timeout("/gallery/listing-batches"),
            Duration::from_secs(600)
        );
        assert_eq!(
            cloud_request_timeout("/gallery/auto-listing/plans"),
            Duration::from_secs(180)
        );
    }

    #[test]
    fn retries_unbatched_preparing_assignments_before_existing_batch() {
        let assignments = vec![
            CloudAssignment {
                id: "completed".into(),
                source_asset_id: "asset-completed".into(),
                external_shop_id: "shop".into(),
                batch_id: Some("existing-batch".into()),
                status: "completed".into(),
            },
            CloudAssignment {
                id: "retry".into(),
                source_asset_id: "asset-retry".into(),
                external_shop_id: "shop".into(),
                batch_id: None,
                status: "preparing".into(),
            },
        ];
        assert!(has_unbatched_preparable_assignments(&assignments));
    }
    #[test]
    fn empty_auto_listing_batch_error_is_recoverable() {
        assert!(is_empty_auto_listing_batch_error(&anyhow!("AUTO_LISTING_NO_NEW_ASSETS")));
        assert!(is_empty_auto_listing_batch_error(&anyhow!("\u{672c}\u{6279}\u{6b21}\u{7d20}\u{6750}\u{5747}\u{5df2}\u{5728}\u{5bf9}\u{5e94}\u{5e97}\u{94fa}\u{5b58}\u{5728}\u{ff0c}\u{5df2}\u{8df3}\u{8fc7}\u{91cd}\u{590d}\u{53d1}\u{5e03}")));
        assert!(!is_empty_auto_listing_batch_error(&anyhow!("listing batch id missing")));
    }
    #[test]
    fn terminal_auto_listing_run_status_is_cleared() {
        assert!(is_terminal_run_status("completed"));
        assert!(is_terminal_run_status("failed"));
        assert!(!is_terminal_run_status("preparing"));
    }




    #[test]
    fn restart_recovers_checkpoint_before_reserving() {
        let mut state = input(at(28, 9, 0));
        state.checkpoint_run_id = Some("run-checkpoint".into());
        assert_eq!(
            decide_next_action(state),
            SchedulerAction::RecoverRun {
                run_id: "run-checkpoint".into(),
            }
        );
    }
}

