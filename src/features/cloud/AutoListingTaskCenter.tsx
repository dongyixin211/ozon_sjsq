import { useState } from "react";
import { LoaderCircle, RefreshCw } from "lucide-react";
import type { AutoListingAssignmentStatus } from "@shared/types";

export type AutoListingTaskCenterSummary = {
  total: number;
  waiting: number;
  preparing: number;
  submitting: number;
  completed: number;
  failed: number;
  dateLabel?: string;
};

export type AutoListingTaskCenterAssignment = {
  id: string;
  sourceAssetId: string;
  sourceSku: string;
  shopName: string;
  externalShopId: string;
  status: AutoListingAssignmentStatus;
  batchId?: string | null;
  canRelease?: boolean;
};

export type AutoListingTaskCenterTask = {
  id: string;
  label: string;
  stage: "waiting" | "preparing" | "submitting" | "completed" | "failed";
  totalCount: number;
  completedCount: number;
  failedCount: number;
  shopAllocations: Array<{ externalShopId: string; shopName: string; count: number }>;
  assignments: AutoListingTaskCenterAssignment[];
  quotaError?: string | null;
  latestError?: string | null;
  legacyLabel?: string | null;
};

export type AutoListingTaskCenterProps = {
  summary: AutoListingTaskCenterSummary | null;
  tasks: AutoListingTaskCenterTask[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
  onPauseTask?: (taskId: string) => void | Promise<void>;
  onContinueTask?: (taskId: string) => void | Promise<void>;
  onRetryFailedOnly?: (taskId: string) => void | Promise<void>;
  onReleaseAssignment?: (taskId: string, assignmentId: string) => void | Promise<void>;
};

const stageLabels: Record<AutoListingTaskCenterTask["stage"], string> = {
  waiting: "等待中",
  preparing: "准备中",
  submitting: "提交中",
  completed: "已完成",
  failed: "失败",
};

export function AutoListingTaskCenter({
  summary,
  tasks,
  loading,
  error,
  onRefresh,
  onPauseTask,
  onContinueTask,
  onRetryFailedOnly,
  onReleaseAssignment,
}: AutoListingTaskCenterProps) {
  const [expandedTaskIds, setExpandedTaskIds] = useState<Set<string>>(() => new Set());

  const toggleTaskDetails = (taskId: string) => {
    setExpandedTaskIds((current) => {
      const next = new Set(current);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  return (
    <section className="auto-listing-task-center">
      <div className="auto-listing-task-center-head">
        <div>
          <span className="eyebrow">批次任务中心</span>
          <h3>上传中任务视图</h3>
          <p className="muted">
            这里按 run / assignment 组织自动上架进度，任务卡只展示批次级统计，图片明细需要展开后查看。
          </p>
        </div>
        <div className="toolbar">
          {summary?.dateLabel ? <span className="badge neutral">{summary.dateLabel}</span> : null}
          {loading ? <span className="badge neutral"><LoaderCircle size={14} className="spin-icon" /> 刷新中</span> : null}
          <button className="secondary-button" disabled={loading} onClick={onRefresh}>
            <RefreshCw size={15} /> 刷新任务中心
          </button>
        </div>
      </div>

      <div className="auto-listing-task-summary">
        <div className="auto-listing-task-metric">
          <span>总计</span>
          <strong>{summary?.total ?? 0}</strong>
        </div>
        <div className="auto-listing-task-metric">
          <span>等待</span>
          <strong>{summary?.waiting ?? 0}</strong>
        </div>
        <div className="auto-listing-task-metric">
          <span>准备中</span>
          <strong>{summary?.preparing ?? 0}</strong>
        </div>
        <div className="auto-listing-task-metric">
          <span>提交中</span>
          <strong>{summary?.submitting ?? 0}</strong>
        </div>
        <div className="auto-listing-task-metric">
          <span>已完成</span>
          <strong>{summary?.completed ?? 0}</strong>
        </div>
        <div className="auto-listing-task-metric">
          <span>失败</span>
          <strong>{summary?.failed ?? 0}</strong>
        </div>
      </div>

      {error ? <div className="alert compact-alert">{error}</div> : null}

      <div className="auto-listing-task-list">
        {tasks.map((task) => {
          const expanded = expandedTaskIds.has(task.id);
          return (
            <article className="task-card" key={task.id}>
              <div className="task-card-head">
                <div className="task-card-title">
                  <strong>{task.label}</strong>
                  <div className="task-card-meta">
                    <span className="task-stage-pill">{stageLabels[task.stage]}</span>
                    {task.legacyLabel ? <span className="task-legacy-pill">{task.legacyLabel}</span> : null}
                    <span>总数 {task.totalCount}</span>
                    <span>完成 {task.completedCount}</span>
                    <span>失败 {task.failedCount}</span>
                  </div>
                </div>
                <div className="task-card-actions">
                  <button className="secondary-button" onClick={() => onPauseTask?.(task.id)}>
                    暂停
                  </button>
                  <button className="secondary-button" onClick={() => onContinueTask?.(task.id)}>
                    继续
                  </button>
                  <button className="secondary-button" onClick={() => onRetryFailedOnly?.(task.id)}>
                    仅重试失败
                  </button>
                  <button className="secondary-button" onClick={() => toggleTaskDetails(task.id)}>
                    {expanded ? "收起图片明细" : "展开图片明细"}
                  </button>
                </div>
              </div>

              {task.shopAllocations.length > 0 ? (
                <div className="task-shop-allocations">
                  {task.shopAllocations.map((allocation) => (
                    <span key={`${task.id}-${allocation.externalShopId}`}>
                      {allocation.shopName} {allocation.count}
                    </span>
                  ))}
                </div>
              ) : null}

              {task.quotaError ? <div className="task-alert quota-error">{task.quotaError}</div> : null}
              {task.latestError ? <div className="task-alert error">{task.latestError}</div> : null}

              {expanded ? (
                <div className="task-assignment-list">
                  {task.assignments.length > 0 ? task.assignments.map((assignment) => {
                    const canRelease = assignment.canRelease ?? (assignment.status === "reserved" && !assignment.batchId);
                    return (
                      <div className="task-assignment-card" key={assignment.id}>
                        <strong>{assignment.sourceSku}</strong>
                        <span>{assignment.shopName}</span>
                        <span>{assignment.status}</span>
                        <span>{assignment.sourceAssetId}</span>
                        {canRelease ? (
                          <button
                            className="secondary-button"
                            onClick={() => onReleaseAssignment?.(task.id, assignment.id)}
                          >
                            释放确认
                          </button>
                        ) : null}
                      </div>
                    );
                  }) : <div className="muted">暂无图片明细</div>}
                </div>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
