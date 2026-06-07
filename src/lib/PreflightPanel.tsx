import type { PreflightIssue } from "@shared/types";

interface Props {
  issues: PreflightIssue[];
  onAction?: (target?: string) => void;
}

export function PreflightPanel({ issues, onAction }: Props) {
  if (issues.length === 0) {
    return <p className="muted">点击预检查后，这里会显示数据是否齐全。</p>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>级别</th>
            <th>范围</th>
            <th>说明</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((issue, index) => (
            <tr key={`${issue.scope}-${index}`} className={`issue-${issue.level}`}>
              <td>{issue.level === "error" ? "错误" : issue.level === "warn" ? "提醒" : "信息"}</td>
              <td>{issue.scope}</td>
              <td>{issue.message}</td>
              <td>
                {issue.actionLabel ? (
                  <button className="secondary-button" onClick={() => onAction?.(issue.actionTarget)}>
                    {issue.actionLabel}
                  </button>
                ) : "-"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function hasBlockingIssues(issues: PreflightIssue[]) {
  return issues.some((issue) => issue.level === "error");
}
