use crate::core::models::{JobKind, JobLog, JobStatus, JobSummary};
use chrono::Utc;
use rusqlite::{params, Connection};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::time::{sleep, Duration};
use uuid::Uuid;

#[derive(Clone, Default)]
pub struct JobRegistry {
    inner: Arc<Mutex<JobRegistryInner>>,
}

#[derive(Default)]
struct JobRegistryInner {
    jobs: HashMap<String, JobSummary>,
    logs: HashMap<String, Vec<JobLog>>,
    cancelled: HashMap<String, bool>,
    db_path: Option<PathBuf>,
}

impl JobRegistry {
    pub fn with_persistence(db_path: PathBuf, jobs: Vec<JobSummary>, logs: Vec<JobLog>) -> Self {
        let registry = Self::default();
        let mut inner = registry.inner.lock().expect("job registry poisoned");
        inner.db_path = Some(db_path);
        let mut restored_jobs = Vec::new();
        for job in jobs {
            let was_unfinished = matches!(job.status, JobStatus::Queued | JobStatus::Running);
            let job = normalize_restored_job(job);
            inner.cancelled.insert(
                job.id.clone(),
                !matches!(job.status, JobStatus::Queued | JobStatus::Running),
            );
            inner.logs.entry(job.id.clone()).or_default();
            if was_unfinished && !matches!(job.status, JobStatus::Queued | JobStatus::Running) {
                restored_jobs.push(job.clone());
            }
            inner.jobs.insert(job.id.clone(), job);
        }
        for log in logs {
            inner.logs.entry(log.job_id.clone()).or_default().push(log);
        }
        drop(inner);
        for job in restored_jobs {
            registry.persist_job(&job);
        }
        registry
    }

    pub fn create_job(
        &self,
        kind: JobKind,
        title: String,
        input_path: Option<String>,
    ) -> JobSummary {
        let job = JobSummary {
            id: Uuid::new_v4().to_string(),
            kind,
            title,
            status: JobStatus::Queued,
            progress: 0,
            input_path,
            output_path: None,
            result_path: None,
            result_excel_path: None,
            success_count: None,
            failed_count: None,
            last_error: None,
            error: None,
            created_at: Utc::now().to_rfc3339(),
            updated_at: Utc::now().to_rfc3339(),
        };
        self.insert_job(job.clone());
        job
    }

    pub fn list_jobs(&self) -> Vec<JobSummary> {
        let mut jobs = self
            .inner
            .lock()
            .expect("job registry poisoned")
            .jobs
            .values()
            .cloned()
            .collect::<Vec<_>>();
        jobs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        jobs
    }

    pub fn list_logs(&self, job_id: &str) -> Vec<JobLog> {
        self.inner
            .lock()
            .expect("job registry poisoned")
            .logs
            .get(job_id)
            .cloned()
            .unwrap_or_default()
    }

    pub fn cancel(&self, job_id: &str) -> bool {
        let mut inner = self.inner.lock().expect("job registry poisoned");
        let mut changed_job = None;
        inner.cancelled.insert(job_id.to_string(), true);
        if let Some(job) = inner.jobs.get_mut(job_id) {
            if matches!(job.status, JobStatus::Queued | JobStatus::Running) {
                job.status = JobStatus::Cancelled;
                job.updated_at = Utc::now().to_rfc3339();
                changed_job = Some(job.clone());
            }
        }
        drop(inner);
        if let Some(job) = changed_job {
            self.persist_job(&job);
            return true;
        }
        false
    }

    pub fn start_demo_job(&self, kind: JobKind, title: String) -> JobSummary {
        let job = self.create_job(kind, title, None);
        let registry = self.clone();
        let job_id = job.id.clone();
        tauri::async_runtime::spawn(async move {
            registry.update(&job_id, JobStatus::Running, 5, None);
            registry.log(&job_id, "info", "任务已进入队列。");
            for step in 1..=10 {
                sleep(Duration::from_millis(180)).await;
                if registry.is_cancelled(&job_id) {
                    registry.log(&job_id, "warn", "任务已取消。");
                    registry.update(&job_id, JobStatus::Cancelled, step * 10, None);
                    return;
                }
                registry.log(&job_id, "info", &format!("完成步骤 {step}/10"));
                registry.update(&job_id, JobStatus::Running, step * 9, None);
            }
            registry.log(&job_id, "info", "任务完成。");
            registry.update(&job_id, JobStatus::Succeeded, 100, None);
        });
        job
    }

    pub fn update(&self, job_id: &str, status: JobStatus, progress: u8, error: Option<String>) {
        self.set_job_state(job_id, status, progress, error, None);
    }

    pub fn resume(&self, job_id: &str) {
        let mut inner = self.inner.lock().expect("job registry poisoned");
        inner.cancelled.insert(job_id.to_string(), false);
        let mut changed_job = None;
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.status = JobStatus::Queued;
            job.last_error = None;
            job.error = None;
            job.updated_at = Utc::now().to_rfc3339();
            changed_job = Some(job.clone());
        }
        drop(inner);
        if let Some(job) = changed_job {
            self.persist_job(&job);
        }
    }

    pub fn complete_with_output(&self, job_id: &str, output_path: Option<String>) {
        self.set_job_state(job_id, JobStatus::Succeeded, 100, None, output_path);
    }

    pub fn complete_with_result(
        &self,
        job_id: &str,
        output_path: Option<String>,
        success_count: usize,
        failed_count: usize,
    ) {
        self.set_job_state(job_id, JobStatus::Succeeded, 100, None, output_path);
        let mut inner = self.inner.lock().expect("job registry poisoned");
        let mut changed_job = None;
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.success_count = Some(success_count);
            job.failed_count = Some(failed_count);
            changed_job = Some(job.clone());
        }
        drop(inner);
        if let Some(job) = changed_job {
            self.persist_job(&job);
        }
    }

    pub fn update_counts(&self, job_id: &str, success_count: usize, failed_count: usize) {
        let mut inner = self.inner.lock().expect("job registry poisoned");
        let mut changed_job = None;
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.success_count = Some(success_count);
            job.failed_count = Some(failed_count);
            job.updated_at = Utc::now().to_rfc3339();
            changed_job = Some(job.clone());
        }
        drop(inner);
        if let Some(job) = changed_job {
            self.persist_job(&job);
        }
    }

    pub fn fail(&self, job_id: &str, error: String) {
        self.set_job_state(job_id, JobStatus::Failed, 100, Some(error), None);
    }

    pub fn log(&self, job_id: &str, level: &str, message: &str) {
        let log = JobLog {
            id: Uuid::new_v4().to_string(),
            job_id: job_id.to_string(),
            level: level.to_string(),
            message: message.to_string(),
            created_at: Utc::now().to_rfc3339(),
        };
        let mut inner = self.inner.lock().expect("job registry poisoned");
        inner
            .logs
            .entry(job_id.to_string())
            .or_default()
            .push(log.clone());
        drop(inner);
        self.persist_log(&log);
    }

    pub fn is_cancelled(&self, job_id: &str) -> bool {
        self.inner
            .lock()
            .expect("job registry poisoned")
            .cancelled
            .get(job_id)
            .copied()
            .unwrap_or(false)
    }

    fn insert_job(&self, job: JobSummary) {
        let mut inner = self.inner.lock().expect("job registry poisoned");
        inner.logs.insert(job.id.clone(), Vec::new());
        inner.cancelled.insert(job.id.clone(), false);
        inner.jobs.insert(job.id.clone(), job.clone());
        drop(inner);
        self.persist_job(&job);
    }

    fn set_job_state(
        &self,
        job_id: &str,
        status: JobStatus,
        progress: u8,
        error: Option<String>,
        output_path: Option<String>,
    ) {
        let mut inner = self.inner.lock().expect("job registry poisoned");
        let mut changed_job = None;
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.status = status;
            job.progress = progress.min(100);
            job.last_error = error.clone();
            job.error = error;
            if output_path.is_some() {
                job.output_path = output_path.clone();
                job.result_path = output_path.clone();
                if output_path
                    .as_deref()
                    .is_some_and(|path| path.to_lowercase().ends_with(".xlsx"))
                {
                    job.result_excel_path = output_path;
                }
            }
            job.updated_at = Utc::now().to_rfc3339();
            changed_job = Some(job.clone());
        }
        drop(inner);
        if let Some(job) = changed_job {
            self.persist_job(&job);
        }
    }

    fn db_path(&self) -> Option<PathBuf> {
        self.inner
            .lock()
            .expect("job registry poisoned")
            .db_path
            .clone()
    }

    fn persist_job(&self, job: &JobSummary) {
        let Some(path) = self.db_path() else {
            return;
        };
        if let Ok(conn) = Connection::open(path) {
            let _ = conn.execute(
                r#"
                INSERT INTO jobs (
                  id, kind, title, status, progress, input_path, output_path, result_path,
                  result_excel_path, success_count, failed_count, last_error, error, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
                ON CONFLICT(id) DO UPDATE SET
                  kind = excluded.kind,
                  title = excluded.title,
                  status = excluded.status,
                  progress = excluded.progress,
                  input_path = excluded.input_path,
                  output_path = excluded.output_path,
                  result_path = excluded.result_path,
                  result_excel_path = excluded.result_excel_path,
                  success_count = excluded.success_count,
                  failed_count = excluded.failed_count,
                  last_error = excluded.last_error,
                  error = excluded.error,
                  updated_at = excluded.updated_at
                "#,
                params![
                    &job.id,
                    job_kind_to_str(job.kind),
                    &job.title,
                    job_status_to_str(job.status),
                    i64::from(job.progress),
                    &job.input_path,
                    &job.output_path,
                    &job.result_path,
                    &job.result_excel_path,
                    job.success_count.and_then(|value| i64::try_from(value).ok()),
                    job.failed_count.and_then(|value| i64::try_from(value).ok()),
                    &job.last_error,
                    &job.error,
                    &job.created_at,
                    &job.updated_at,
                ],
            );
        }
    }

    fn persist_log(&self, log: &JobLog) {
        let Some(path) = self.db_path() else {
            return;
        };
        if let Ok(conn) = Connection::open(path) {
            let _ = conn.execute(
                r#"
                INSERT INTO job_logs (id, job_id, level, message, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5)
                ON CONFLICT(id) DO NOTHING
                "#,
                params![
                    &log.id,
                    &log.job_id,
                    &log.level,
                    &log.message,
                    &log.created_at
                ],
            );
        }
    }
}

fn normalize_restored_job(mut job: JobSummary) -> JobSummary {
    if matches!(job.status, JobStatus::Queued | JobStatus::Running) {
        if job.kind == JobKind::GalleryUpload {
            return job;
        }
        job.status = JobStatus::Cancelled;
        job.progress = job.progress.min(100);
        job.last_error = Some("客户端上次退出时任务未完成，已标记为已取消。".to_string());
        job.error = job.last_error.clone();
        job.updated_at = Utc::now().to_rfc3339();
    }
    job
}

fn job_status_to_str(value: JobStatus) -> &'static str {
    match value {
        JobStatus::Queued => "queued",
        JobStatus::Running => "running",
        JobStatus::Succeeded => "succeeded",
        JobStatus::Failed => "failed",
        JobStatus::Cancelled => "cancelled",
    }
}

fn job_kind_to_str(value: JobKind) -> &'static str {
    match value {
        JobKind::Materials => "materials",
        JobKind::SceneLocal => "scene_local",
        JobKind::SceneAi => "scene_ai",
        JobKind::LocalMockup => "local_mockup",
        JobKind::AutoListing => "auto_listing",
        JobKind::GalleryUpload => "gallery_upload",
        JobKind::BatchUpload => "batch_upload",
        JobKind::ListingImageRepair => "listing_image_repair",
        JobKind::ListedUpdate => "listed_update",
        JobKind::FollowSync => "follow_sync",
        JobKind::FollowAutomation => "follow_automation",
        JobKind::ListingMaintenance => "listing_maintenance",
        JobKind::Inventory => "inventory",
        JobKind::Barcode => "barcode",
        JobKind::OrderDocuments => "order_documents",
        JobKind::ApiTest => "api_test",
    }
}
