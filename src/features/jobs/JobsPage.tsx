import { useEffect, useRef, useState } from "react";
import { Copy, FolderOpen } from "lucide-react";
import type { JobLog, JobSummary } from "@shared/types";
import { api } from "../../lib/api";
import { createCloudClient, getCloudToken } from "../../lib/cloudApi";
import { formatDate, jobKindText, statusText } from "../../lib/format";

const TASK_HISTORY_SYNC_DEBOUNCE_MS = import.meta.env.MODE === "test" ? 0 : 10_000;

interface Props {
  jobs: JobSummary[];
  selectedJobId?: string;
  cloudApiBaseUrl?: string;
  onChanged: () => void;
}

export function JobsPage({ jobs, selectedJobId, cloudApiBaseUrl, onChanged }: Props) {
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>(selectedJobId || "");
  const [loadedLogJob, setLoadedLogJob] = useState("");
  const [jobPage, setJobPage] = useState(1);
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(10);
  const [copyStatus, setCopyStatus] = useState("");
  const [cloudSyncStatus, setCloudSyncStatus] = useState("");
  const lastCloudSyncSignature = useRef("");
  const cloudSyncTimer = useRef<number | undefined>(undefined);
  const latestLogRequestRef = useRef(0);

  const loadLogs = async (jobId: string, resetPage = false) => {
    const requestId = latestLogRequestRef.current + 1;
    latestLogRequestRef.current = requestId;
    const nextLogs = await api.listJobLogs(jobId);
    if (requestId !== latestLogRequestRef.current) return;
    setLogs(nextLogs);
    if (resetPage) {
      setLogPage(1);
    }
  };

  const openLogs = async (jobId: string) => {
    setSelectedJob(jobId);
    setLoadedLogJob(jobId);
    await loadLogs(jobId, true);
  };

  useEffect(() => {
    const jobIds = new Set(jobs.map((job) => job.id));
    const selectedStillExists = selectedJob && jobIds.has(selectedJob);
    const nextJob = selectedJobId || (selectedStillExists ? selectedJob : jobs[0]?.id ?? "");
    if (!nextJob) {
      setSelectedJob("");
      setLoadedLogJob("");
      setLogs([]);
      return;
    }
    if (nextJob !== selectedJob || nextJob !== loadedLogJob) {
      openLogs(nextJob).catch(() => undefined);
    }
  }, [jobs, selectedJob, selectedJobId, loadedLogJob]);

  useEffect(() => {
    if (!selectedJob) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      loadLogs(selectedJob).catch(() => undefined);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [selectedJob]);

  useEffect(() => {
    if (jobs.length === 0 || !getCloudToken()) {
      return;
    }
    const recentJobs = jobs.slice(0, 200);
    const recentLogs = logs.slice(-200);
    const syncSignature = JSON.stringify({
      jobs: recentJobs.map((job) => ({
        id: job.id,
        status: job.status,
        progress: job.progress,
        updatedAt: job.updatedAt,
        successCount: job.successCount,
        failedCount: job.failedCount,
        lastError: job.lastError,
        error: job.error,
      })),
      logs: recentLogs.map((log) => ({
        id: log.id,
        level: log.level,
        message: log.message,
        createdAt: log.createdAt,
      })),
    });
    if (syncSignature === lastCloudSyncSignature.current) {
      return;
    }
    lastCloudSyncSignature.current = syncSignature;
    if (cloudSyncTimer.current) {
      window.clearTimeout(cloudSyncTimer.current);
    }
    cloudSyncTimer.current = window.setTimeout(() => {
      const client = createCloudClient(cloudApiBaseUrl || "https://api.dyxtoolai.cn");
      client.syncTaskHistory({ jobs: recentJobs, logs: recentLogs })
        .then((result) => setCloudSyncStatus(`已同步到云端：${result.jobsSynced} 个任务 / ${result.logsSynced} 条日志`))
        .catch((error) => setCloudSyncStatus(`云端同步暂未完成，稍后会自动重试：${readableError(error)}`));
    }, TASK_HISTORY_SYNC_DEBOUNCE_MS);
    return () => {
      if (cloudSyncTimer.current) {
        window.clearTimeout(cloudSyncTimer.current);
      }
    };
  }, [cloudApiBaseUrl, jobs, logs]);

  const totalLogPages = Math.max(1, Math.ceil(logs.length / Math.max(1, logPageSize)));
  const currentLogPage = Math.min(logPage, totalLogPages);
  const pagedLogs = logs.slice((currentLogPage - 1) * logPageSize, currentLogPage * logPageSize);
  const logText = pagedLogs.map((log) => `[${formatDate(log.createdAt)}] ${log.level.toUpperCase()} ${log.message}`).join("\n");
  const selectedJobSummary = jobs.find((job) => job.id === selectedJob);
  const jobPageSize = 10;
  const totalJobPages = Math.max(1, Math.ceil(jobs.length / jobPageSize));
  const currentJobPage = Math.min(jobPage, totalJobPages);
  const pagedJobs = jobs.slice((currentJobPage - 1) * jobPageSize, currentJobPage * jobPageSize);

  useEffect(() => {
    if (jobPage > totalJobPages) {
      setJobPage(totalJobPages);
    }
  }, [jobPage, totalJobPages]);

  const copyLogs = async () => {
    if (!logText.trim()) return;
    try {
      await navigator.clipboard?.writeText(logText);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus("复制失败");
    }
  };

  return (
    <div className="content-grid">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>任务记录</h2>
            <p className="muted">任务完成后从这里打开结果、查看日志、处理失败原因。</p>
          </div>
          <button className="secondary-button" onClick={onChanged}>刷新</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>统计</th>
                <th>路径</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {pagedJobs.map((job) => {
                const resultPath = job.resultExcelPath || job.resultPath || job.outputPath;
                return (
                  <tr key={job.id} className={selectedJob === job.id ? "selected-row" : ""}>
                    <td>
                      <strong>{job.title}</strong>
                      <div className="muted">{jobKindText(job.kind)}</div>
                    </td>
                    <td>
                      <div>{statusText(job.status)}</div>
                      <div className="progress"><span style={{ width: `${job.progress}%` }} /></div>
                      {(job.lastError || job.error) ? <div className="error-text">{job.lastError || job.error}</div> : null}
                    </td>
                    <td>
                      {job.successCount !== undefined || job.failedCount !== undefined
                        ? `成功 ${job.successCount ?? 0} / 失败 ${job.failedCount ?? 0}`
                        : "-"}
                    </td>
                    <td className="path-cell">{resultPath || job.inputPath || "-"}</td>
                    <td>{formatDate(job.updatedAt)}</td>
                    <td>
                      <div className="actions">
                        <button className="secondary-button" onClick={() => openLogs(job.id)}>日志</button>
                        {resultPath ? (
                          <button className="secondary-button" onClick={() => api.openPath(resultPath)}>
                            <FolderOpen size={15} /> 结果
                          </button>
                        ) : null}
                        {job.status === "failed" ? (
                          <button className="secondary-button" onClick={() => openLogs(job.id)}>失败原因</button>
                        ) : null}
                        {job.status === "running" || job.status === "queued" ? (
                          <button
                            className="danger-button"
                            onClick={async () => {
                              await api.cancelJob(job.id);
                              onChanged();
                            }}
                          >
                            取消
                          </button>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {jobs.length === 0 ? <tr><td colSpan={6} className="muted">暂无任务。</td></tr> : null}
            </tbody>
          </table>
        </div>
        {totalJobPages > 1 ? (
          <div className="pagination-bar">
            <button className="secondary-button" disabled={currentJobPage <= 1} onClick={() => setJobPage(1)}>首页</button>
            <button className="secondary-button" disabled={currentJobPage <= 1} onClick={() => setJobPage(currentJobPage - 1)}>上一页</button>
            <span>第 {currentJobPage} / {totalJobPages} 页，每页 10 个任务</span>
            <button className="secondary-button" disabled={currentJobPage >= totalJobPages} onClick={() => setJobPage(currentJobPage + 1)}>下一页</button>
            <button className="secondary-button" disabled={currentJobPage >= totalJobPages} onClick={() => setJobPage(totalJobPages)}>末页</button>
          </div>
        ) : null}
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>运行日志</h2>
          <div className="toolbar">
            <span className="muted">{selectedJob || "未选择任务"} · 共 {logs.length} 条 · 第 {currentLogPage}/{totalLogPages} 页</span>
            {cloudSyncStatus ? <span className="muted">{cloudSyncStatus}</span> : null}
            {copyStatus ? <span className="muted">{copyStatus}</span> : null}
            <select value={logPageSize} onChange={(event) => {
              setLogPageSize(Number(event.target.value));
              setLogPage(1);
            }}>
              {[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size} 条/页</option>)}
            </select>
            <button className="secondary-button" disabled={!logText.trim()} onClick={copyLogs}>
              <Copy size={15} /> 复制
            </button>
            <button className="secondary-button" disabled={currentLogPage <= 1} onClick={() => setLogPage(1)}>首页</button>
            <button className="secondary-button" disabled={currentLogPage <= 1} onClick={() => setLogPage(currentLogPage - 1)}>上一页</button>
            <button className="secondary-button" disabled={currentLogPage >= totalLogPages} onClick={() => setLogPage(currentLogPage + 1)}>下一页</button>
            <button className="secondary-button" disabled={currentLogPage >= totalLogPages} onClick={() => setLogPage(totalLogPages)}>末页</button>
          </div>
        </div>
        {selectedJobSummary ? (
          <div className="log-summary-row">
            <span className="badge neutral">{jobKindText(selectedJobSummary.kind)}</span>
            <span className="badge neutral">{statusText(selectedJobSummary.status)}</span>
            <span className="muted">{selectedJobSummary.title}</span>
          </div>
        ) : null}
        <div className="log-list">
          {pagedLogs.map((log) => (
            <article className={`log-entry log-entry-${log.level}`} key={log.id}>
              <div className="log-entry-meta">
                <span className="log-entry-time">{formatDate(log.createdAt)}</span>
                <span className="log-entry-level">{log.level.toUpperCase()}</span>
              </div>
              <p>{log.message}</p>
            </article>
          ))}
          {pagedLogs.length === 0 ? <div className="log-empty">选择任务后查看日志。</div> : null}
        </div>
      </section>
    </div>
  );
}

function readableError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");
}
