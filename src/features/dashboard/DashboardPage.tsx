import { ArrowRight, CheckCircle2, FolderOpen, Play, Settings, XCircle } from "lucide-react";
import type { AppSettings, JobSummary, ProviderSecretStatus, ReadinessCheck, Shop } from "@shared/types";
import { api } from "../../lib/api";
import { formatDate, jobKindText, statusText } from "../../lib/format";

interface Props {
  shops: Shop[];
  jobs: JobSummary[];
  settings: AppSettings;
  providerSecrets: ProviderSecretStatus;
  onNavigate: (page: "materials" | "scene" | "ozon" | "jobs" | "settings") => void;
  onOpenJobLogs: (jobId: string) => void;
}

export function DashboardPage({ shops, jobs, settings, providerSecrets, onNavigate, onOpenJobLogs }: Props) {
  const activeShops = shops.filter((shop) => shop.enabled);
  const runningJobs = jobs.filter((job) => job.status === "running" || job.status === "queued");
  const lastJobs = jobs.slice(0, 5);
  const hasOzonKey = activeShops.some((shop) => shop.apiKeyStored);
  const hasOss = activeShops.some((shop) => shop.ossAccessKeyStored && shop.ossBucket && shop.ossEndpoint);
  const hasDefaultDirs = Boolean(settings.defaultSourceRoot && settings.defaultOutputRoot);
  const aiReady = providerSecrets.imageApiKeyStored || providerSecrets.textApiKeyStored;

  const readiness: ReadinessCheck[] = [
    {
      key: "shops",
      label: "店铺配置",
      ready: activeShops.length > 0 && hasOzonKey,
      detail: activeShops.length > 0 ? `${activeShops.length} 个启用店铺` : "还没有启用店铺",
      actionLabel: "配置店铺",
      actionTarget: "settings",
    },
    {
      key: "ai",
      label: "AI 密钥",
      ready: aiReady,
      detail: aiReady ? "图片或文案密钥已保存" : "未保存 AI 密钥",
      actionLabel: "配置 AI",
      actionTarget: "settings",
    },
    {
      key: "dirs",
      label: "默认目录",
      ready: hasDefaultDirs,
      detail: hasDefaultDirs ? "源目录和输出目录已设置" : "建议先设置常用目录",
      actionLabel: "设置目录",
      actionTarget: "settings",
    },
    {
      key: "jobs",
      label: "最近任务",
      ready: runningJobs.length === 0,
      detail: runningJobs.length ? `${runningJobs.length} 个任务运行中` : "当前没有运行中任务",
      actionLabel: "任务记录",
      actionTarget: "jobs",
    },
  ];

  const flows = [
    {
      title: "生成素材",
      detail: "生成 3:4 商品图、水印、AI 图片和文案。",
      ready: hasDefaultDirs,
      action: () => onNavigate(hasDefaultDirs ? "materials" : "settings"),
      actionLabel: hasDefaultDirs ? "开始生成" : "先设目录",
    },
    {
      title: "批量上架",
      detail: "检查 Excel、图片和 OSS 后提交 Ozon import。",
      ready: activeShops.length > 0 && hasOzonKey && hasOss,
      action: () => onNavigate(activeShops.length > 0 && hasOzonKey && hasOss ? "ozon" : "settings"),
      actionLabel: activeShops.length > 0 && hasOzonKey && hasOss ? "进入上架" : "先配店铺/OSS",
    },
    {
      title: "更新已上架商品",
      detail: "按货号更新标题、简介、图片、视频和富内容。",
      ready: activeShops.length > 0 && hasOzonKey,
      action: () => onNavigate(activeShops.length > 0 && hasOzonKey ? "ozon" : "settings"),
      actionLabel: activeShops.length > 0 && hasOzonKey ? "进入更新" : "先配 Ozon",
    },
  ];

  return (
    <div className="content-grid">
      {readiness.map((item) => (
        <section className="panel third" key={item.key}>
          <div className="status-row">
            {item.ready ? <CheckCircle2 size={18} className="ok-icon" /> : <XCircle size={18} className="bad-icon" />}
            <strong>{item.label}</strong>
          </div>
          <p className="muted">{item.detail}</p>
          {!item.ready ? (
            <button className="secondary-button" onClick={() => onNavigate(item.actionTarget as "settings" | "jobs")}>
              <Settings size={15} /> {item.actionLabel}
            </button>
          ) : null}
        </section>
      ))}

      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>主流程</h2>
            <p className="muted">按实际运营顺序开始，缺配置时直接跳到对应位置。</p>
          </div>
        </div>
        <div className="workflow-grid">
          {flows.map((flow) => (
            <div className="workflow-card" key={flow.title}>
              <div>
                <span className={flow.ready ? "badge" : "badge warn"}>{flow.ready ? "可开始" : "需配置"}</span>
                <h3>{flow.title}</h3>
                <p className="muted">{flow.detail}</p>
              </div>
              <button className={flow.ready ? "primary-button" : "secondary-button"} onClick={flow.action}>
                <Play size={15} /> {flow.actionLabel}
              </button>
            </div>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>最近任务</h2>
          <button className="secondary-button" onClick={() => onNavigate("jobs")}>查看全部</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>任务</th>
                <th>状态</th>
                <th>结果</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {lastJobs.map((job) => (
                <tr key={job.id}>
                  <td>
                    <strong>{job.title}</strong>
                    <div className="muted">{jobKindText(job.kind)}</div>
                  </td>
                  <td>
                    <div>{statusText(job.status)}</div>
                    <div className="progress"><span style={{ width: `${job.progress}%` }} /></div>
                  </td>
                  <td>
                    {job.successCount !== undefined || job.failedCount !== undefined
                      ? `成功 ${job.successCount ?? 0} / 失败 ${job.failedCount ?? 0}`
                      : job.resultPath || job.outputPath || "-"}
                  </td>
                  <td>{formatDate(job.updatedAt)}</td>
                  <td>
                    <div className="actions">
                      <button className="secondary-button" onClick={() => onOpenJobLogs(job.id)}>日志</button>
                      {(job.resultExcelPath || job.resultPath || job.outputPath) ? (
                        <button className="secondary-button" onClick={() => api.openPath(job.resultExcelPath || job.resultPath || job.outputPath || "")}>
                          <FolderOpen size={15} /> 结果
                        </button>
                      ) : null}
                      <button className="secondary-button" onClick={() => onNavigate(job.kind === "materials" ? "materials" : job.kind === "scene_local" ? "scene" : "ozon")}>
                        继续 <ArrowRight size={15} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {lastJobs.length === 0 ? (
                <tr><td colSpan={5} className="muted">暂无任务。先从上方主流程开始。</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
