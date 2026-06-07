use crate::core::models::{JobKind, JobLog, JobStatus, JobSummary};
use chrono::Utc;
use std::collections::HashMap;
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
}

impl JobRegistry {
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
        inner.cancelled.insert(job_id.to_string(), true);
        if let Some(job) = inner.jobs.get_mut(job_id) {
            if matches!(job.status, JobStatus::Queued | JobStatus::Running) {
                job.status = JobStatus::Cancelled;
                job.updated_at = Utc::now().to_rfc3339();
                return true;
            }
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
        if let Some(job) = inner.jobs.get_mut(job_id) {
            job.success_count = Some(success_count);
            job.failed_count = Some(failed_count);
        }
    }

    pub fn fail(&self, job_id: &str, error: String) {
        self.set_job_state(job_id, JobStatus::Failed, 100, Some(error), None);
    }

    pub fn log(&self, job_id: &str, level: &str, message: &str) {
        let mut inner = self.inner.lock().expect("job registry poisoned");
        inner
            .logs
            .entry(job_id.to_string())
            .or_default()
            .push(JobLog {
                id: Uuid::new_v4().to_string(),
                job_id: job_id.to_string(),
                level: level.to_string(),
                message: message.to_string(),
                created_at: Utc::now().to_rfc3339(),
            });
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
        inner.jobs.insert(job.id.clone(), job);
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
        }
    }
}
