import { useEffect, useState } from "react";
import { FolderOpen } from "lucide-react";
import type { JobLog, JobSummary } from "@shared/types";
import { api } from "../../lib/api";
import { formatDate, jobKindText, statusText } from "../../lib/format";

interface Props {
  jobs: JobSummary[];
  selectedJobId?: string;
  onChanged: () => void;
}

export function JobsPage({ jobs, selectedJobId, onChanged }: Props) {
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [selectedJob, setSelectedJob] = useState<string>(selectedJobId || jobs[0]?.id || "");
  const [logPage, setLogPage] = useState(1);
  const [logPageSize, setLogPageSize] = useState(10);

  const openLogs = async (jobId: string) => {
    setSelectedJob(jobId);
    setLogs(await api.listJobLogs(jobId));
    setLogPage(1);
  };

  useEffect(() => {
    const next = selectedJobId || selectedJob || jobs[0]?.id || "";
    if (next) {
      openLogs(next).catch(() => undefined);
    }
  }, [selectedJobId, jobs]);

  const totalLogPages = Math.max(1, Math.ceil(logs.length / Math.max(1, logPageSize)));
  const currentLogPage = Math.min(logPage, totalLogPages);
  const pagedLogs = logs.slice((currentLogPage - 1) * logPageSize, currentLogPage * logPageSize);

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
              {jobs.map((job) => {
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
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>运行日志</h2>
          <div className="toolbar">
            <span className="muted">{selectedJob || "未选择任务"} · 共 {logs.length} 条 · 第 {currentLogPage}/{totalLogPages} 页</span>
            <select value={logPageSize} onChange={(event) => {
              setLogPageSize(Number(event.target.value));
              setLogPage(1);
            }}>
              {[10, 20, 50, 100].map((size) => <option key={size} value={size}>{size} 条/页</option>)}
            </select>
            <button className="secondary-button" disabled={currentLogPage <= 1} onClick={() => setLogPage(1)}>首页</button>
            <button className="secondary-button" disabled={currentLogPage <= 1} onClick={() => setLogPage(currentLogPage - 1)}>上一页</button>
            <button className="secondary-button" disabled={currentLogPage >= totalLogPages} onClick={() => setLogPage(currentLogPage + 1)}>下一页</button>
            <button className="secondary-button" disabled={currentLogPage >= totalLogPages} onClick={() => setLogPage(totalLogPages)}>末页</button>
          </div>
        </div>
        <pre className="log-box">
          {pagedLogs.length
            ? pagedLogs.map((log) => `[${formatDate(log.createdAt)}] ${log.level.toUpperCase()} ${log.message}`).join("\n")
            : "选择任务后查看日志。"}
        </pre>
      </section>
    </div>
  );
}
