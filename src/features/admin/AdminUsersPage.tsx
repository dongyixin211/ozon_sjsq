import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Search, Shield, UserCog, X } from "lucide-react";
import type { AppSettings } from "@shared/types";
import {
  createCloudClient,
  type AdminUserListItem,
  type AdminUserFeatureAccess,
  type AdminFeatureFlag,
} from "../../lib/cloudApi";
import { useFeatures } from "../../lib/featuresContext";

interface Props {
  settings: AppSettings;
}

const ROLE_LABELS: Record<string, string> = {
  member: "普通用户",
  beta: "内测用户",
  admin: "管理员",
};

const PAGE_SIZE = 20;

export function AdminUsersPage({ settings }: Props) {
  const client = useMemo(() => createCloudClient(settings.cloudApiBaseUrl), [settings.cloudApiBaseUrl]);
  const { role } = useFeatures();
  const [users, setUsers] = useState<AdminUserListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [membership, setMembership] = useState<"all" | "active" | "expired" | "none">("all");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedUser, setSelectedUser] = useState<AdminUserListItem | null>(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await client.adminListUsers({
        keyword: keyword.trim() || undefined,
        membership,
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
      });
      setUsers(result.items);
      setTotal(result.total);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [client, keyword, membership, page]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleRoleChange = async (userId: string, newRole: "member" | "beta" | "admin") => {
    try {
      await client.adminUpdateUserRole(userId, newRole);
      setUsers((prev) => prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u)));
      setMessage("角色已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <section className="panel" style={{ minHeight: "60vh" }}>
      <div className="panel-header">
        <div>
          <span className="eyebrow">RBAC 管理</span>
          <h2>用户管理</h2>
        </div>
        <button className="secondary-button" onClick={fetchUsers} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin-icon" : undefined} />
          刷新
        </button>
      </div>

      <div className="toolbar" style={{ marginBottom: "12px", flexWrap: "wrap", gap: "8px" }}>
        <div className="field" style={{ minWidth: "180px" }}>
          <input
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (setPage(0), fetchUsers())}
            placeholder="搜索手机号或昵称"
          />
        </div>
        <div className="field" style={{ minWidth: "120px" }}>
          <select value={membership} onChange={(e) => { setMembership(e.target.value as typeof membership); setPage(0); }}>
            <option value="all">全部会员</option>
            <option value="active">有效会员</option>
            <option value="expired">过期会员</option>
            <option value="none">无会员</option>
          </select>
        </div>
        <button className="primary-button" onClick={() => { setPage(0); fetchUsers(); }}>
          <Search size={15} /> 搜索
        </button>
      </div>

      {message ? <div className="alert" style={{ marginBottom: "12px" }}>{message}</div> : null}

      <div style={{ overflowX: "auto" }}>
        <table className="data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>
              <th style={{ padding: "8px" }}>手机号</th>
              <th style={{ padding: "8px" }}>昵称</th>
              <th style={{ padding: "8px" }}>角色</th>
              <th style={{ padding: "8px" }}>会员到期</th>
              <th style={{ padding: "8px" }}>店铺数</th>
              <th style={{ padding: "8px" }}>注册时间</th>
              <th style={{ padding: "8px" }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} style={{ borderBottom: "1px solid #f0f0f0" }}>
                <td style={{ padding: "8px" }}>{user.phone}</td>
                <td style={{ padding: "8px" }}>{user.display_name || "-"}</td>
                <td style={{ padding: "8px" }}>
                  <select
                    value={user.role}
                    onChange={(e) => handleRoleChange(user.id, e.target.value as "member" | "beta" | "admin")}
                    style={{ fontSize: "12px", padding: "2px 6px" }}
                    disabled={role !== "admin"}
                  >
                    <option value="member">{ROLE_LABELS.member}</option>
                    <option value="beta">{ROLE_LABELS.beta}</option>
                    <option value="admin">{ROLE_LABELS.admin}</option>
                  </select>
                </td>
                <td style={{ padding: "8px" }}>
                  {user.membership_expires_at
                    ? new Date(user.membership_expires_at).toLocaleDateString("zh-CN")
                    : "-"}
                </td>
                <td style={{ padding: "8px" }}>{user.shop_count}</td>
                <td style={{ padding: "8px" }}>{new Date(user.created_at).toLocaleDateString("zh-CN")}</td>
                <td style={{ padding: "8px" }}>
                  <button className="secondary-button" style={{ fontSize: "12px", padding: "2px 8px" }} onClick={() => setSelectedUser(user)}>
                    <UserCog size={13} /> 权限
                  </button>
                </td>
              </tr>
            ))}
            {users.length === 0 && !loading ? (
              <tr>
                <td colSpan={7} style={{ padding: "24px", textAlign: "center", color: "#9ca3af" }}>暂无用户数据</td>
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
            第 {page + 1} / {totalPages} 页（共 {total} 人）
          </span>
          <button className="secondary-button" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>
            下一页 <ChevronRight size={15} />
          </button>
        </div>
      ) : null}

      {selectedUser ? (
        <UserFeatureDrawer
          user={selectedUser}
          client={client}
          onClose={() => setSelectedUser(null)}
          onMessage={setMessage}
        />
      ) : null}
    </section>
  );
}

// ============================================================
// 用户功能权限抽屉
// ============================================================

function UserFeatureDrawer({
  user,
  client,
  onClose,
  onMessage,
}: {
  user: AdminUserListItem;
  client: ReturnType<typeof createCloudClient>;
  onClose: () => void;
  onMessage: (msg: string) => void;
}) {
  const [access, setAccess] = useState<AdminUserFeatureAccess[]>([]);
  const [features, setFeatures] = useState<AdminFeatureFlag[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedFeature, setSelectedFeature] = useState("");

  const fetchAccess = useCallback(async () => {
    setLoading(true);
    try {
      const [accessResult, featuresResult] = await Promise.all([
        client.adminGetUserFeatures(user.id),
        client.adminListFeatures(),
      ]);
      setAccess(accessResult.access);
      setFeatures(featuresResult.features);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [client, user.id, onMessage]);

  useEffect(() => {
    fetchAccess();
  }, [fetchAccess]);

  const grantFeature = async () => {
    if (!selectedFeature) return;
    try {
      await client.adminGrantUserFeature(user.id, selectedFeature);
      onMessage("功能权限已授予");
      setSelectedFeature("");
      fetchAccess();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const revokeFeature = async (featureKey: string) => {
    try {
      await client.adminRevokeUserFeature(user.id, featureKey);
      onMessage("功能权限已撤销");
      fetchAccess();
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const availableFeatures = features.filter(
    (f) => !access.some((a) => a.feature_key === f.key && !a.revoked_at),
  );

  return (
    <div className="admin-drawer-overlay" onClick={onClose}>
      <div className="admin-drawer" onClick={(e) => e.stopPropagation()} style={{
        position: "fixed", right: 0, top: 0, bottom: 0, width: "420px",
        background: "#fff", boxShadow: "-4px 0 16px rgba(0,0,0,0.08)",
        padding: "20px", overflowY: "auto", zIndex: 1000,
      }}>
        <div className="toolbar" style={{ justifyContent: "space-between", marginBottom: "16px" }}>
          <div>
            <span className="eyebrow">用户功能权限</span>
            <h3 style={{ margin: 0 }}>{user.phone}</h3>
          </div>
          <button className="icon-button" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="panel-subsection" style={{ marginBottom: "16px" }}>
          <div className="muted" style={{ fontSize: "12px", marginBottom: "8px" }}>当前角色：{ROLE_LABELS[user.role] || user.role}</div>

          {loading ? (
            <div className="muted" style={{ textAlign: "center", padding: "20px" }}>加载中...</div>
          ) : (
            <>
              <div style={{ marginBottom: "16px" }}>
                <strong style={{ fontSize: "13px", display: "block", marginBottom: "8px" }}>已授权功能</strong>
                {access.filter((a) => !a.revoked_at).length === 0 ? (
                  <span className="muted" style={{ fontSize: "12px" }}>暂无个人授权（仅依赖角色默认权限）</span>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
                    {access.filter((a) => !a.revoked_at).map((item) => (
                      <div key={item.feature_key} style={{
                        display: "flex", alignItems: "center", justifyContent: "space-between",
                        padding: "6px 10px", background: "#f9fafb", borderRadius: "4px", fontSize: "12px",
                      }}>
                        <div>
                          <strong>{item.label}</strong>
                          <span className="muted" style={{ marginLeft: "6px" }}>{item.feature_key}</span>
                          {item.expires_at ? (
                            <span className="muted" style={{ marginLeft: "6px" }}>
                              到期：{new Date(item.expires_at).toLocaleDateString("zh-CN")}
                            </span>
                          ) : null}
                        </div>
                        <button className="secondary-button" style={{ fontSize: "11px", padding: "1px 6px" }} onClick={() => revokeFeature(item.feature_key)}>
                          撤销
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {availableFeatures.length > 0 ? (
                <div className="toolbar" style={{ gap: "8px" }}>
                  <div className="field" style={{ flex: 1 }}>
                    <select value={selectedFeature} onChange={(e) => setSelectedFeature(e.target.value)}>
                      <option value="">选择功能...</option>
                      {availableFeatures.map((f) => (
                        <option key={f.key} value={f.key}>{f.label} ({f.key})</option>
                      ))}
                    </select>
                  </div>
                  <button className="primary-button" disabled={!selectedFeature} onClick={grantFeature}>
                    <Shield size={14} /> 授予
                  </button>
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
