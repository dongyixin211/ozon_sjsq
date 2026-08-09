import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import type { AppSettings } from "@shared/types";
import { createCloudClient, type AdminAuditLogItem } from "../../lib/cloudApi";

interface Props {
  settings: AppSettings;
}

const ACTION_LABELS: Record<string, string> = {
  role_change: "角色变更",
  feature_grant: "授权功能",
  feature_revoke: "撤销功能",
};

const PAGE_SIZE = 30;

export function AdminLogsPage({ settings }: Props) {
  const client = useMemo(() => createCloudClient(settings.cloudApiBaseUrl), [settings.cloudApiBaseUrl]);
  const [logs, setLogs] = useState<AdminAuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [actionFilter, setActionFilter] = useState<"all" | "role_change" | "feature_grant" | "feature_revoke">("all");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await client.adminListAuditLogs({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        action: actionFilter,
      });
      setLogs(result.items);
      setTotal(result.total);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [client, page, actionFilter]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <section className="panel" style={{ minHeight: "60vh" }}>
      <div className="panel-header">
        <div>
          <span className="eyebrow">RBAC 管理</span>
          <h2>操作日志</h2>
        </div>
        <button className="secondary-button" onClick={fetchLogs} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin-icon" : undefined} />
          刷新
        </button>
      </div>

      <div className="toolbar" style={{ marginBottom: "12px", gap: "8px" }}>
        <div className="field" style={{ minWidth: "150px" }}>
          <select value={actionFilter} onChange={(e) => { setActionFilter(e.target.value as typeof actionFilter); setPage(0); }}>
            <option value="all">全部操作</option>
            <option value="role_change">角色变更</option>
            <option value="feature_grant">授权功能</option>
            <option value="feature_revoke">撤销功能</option>
          </select>
        </div>
      </div>

      {message ? <div className="alert" style={{ marginBottom: "12px" }}>{message}</div> : null}

      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>
              <th style={{ padding: "8px" }}>时间</th>
              <th style={{ padding: "8px" }}>操作</th>
              <th style={{ padding: "8px" }}>操作人</th>
              <th style={{ padding: "8px" }}>目标用户</th>
              <th style={{ padding: "8px" }}>功能标识</th>
              <th style={{ padding: "8px" }}>变更内容</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((log) => (
              <tr key={log.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: "8px", whiteSpace: "nowrap" }}>
                  {new Date(log.created_at).toLocaleString("zh-CN", { hour12: false })}
                </td>
                <td style={{ padding: "8px" }}>
                  <span className="badge" style={{ fontSize: "11px" }}>
                    {ACTION_LABELS[log.action] || log.action}
                  </span>
                </td>
                <td style={{ padding: "8px" }}>{log.admin_phone || "-"}</td>
                <td style={{ padding: "8px" }}>{log.target_phone || "-"}</td>
                <td style={{ padding: "8px" }}>
                  {log.feature_key ? (
                    <code style={{ fontSize: "11px", background: "#f3f4f6", padding: "1px 4px", borderRadius: "2px" }}>
                      {log.feature_key}
                    </code>
                  ) : "-"}
                </td>
                <td style={{ padding: "8px" }}>
                  <span className="muted" style={{ fontSize: "12px" }}>{log.new_value || "-"}</span>
                </td>
              </tr>
            ))}
            {logs.length === 0 && !loading ? (
              <tr>
                <td colSpan={6} style={{ padding: "24px", textAlign: "center", color: "#9ca3af" }}>暂无操作日志</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {total > PAGE_SIZE ? (
        <div className="toolbar" style={{ marginTop: "12px", justifyContent: "center" }}>
          <button className="secondary-button" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft size={15} /> 上一页
          </button>
          <span className="muted" style={{ fontSize: "13px" }}>
            第 {page + 1} / {totalPages} 页（共 {total} 条）
          </span>
          <button className="secondary-button" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
            下一页 <ChevronRight size={15} />
          </button>
        </div>
      ) : null}
    </section>
  );
}
