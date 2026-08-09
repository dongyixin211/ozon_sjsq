import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, ToggleLeft, ToggleRight } from "lucide-react";
import type { AppSettings } from "@shared/types";
import { createCloudClient, type AdminFeatureFlag } from "../../lib/cloudApi";

interface Props {
  settings: AppSettings;
}

const ROLE_LABELS: Record<string, string> = {
  member: "普通用户",
  beta: "内测用户",
  admin: "管理员",
};

const ALL_ROLES: ("member" | "beta" | "admin")[] = ["member", "beta", "admin"];

export function AdminFeaturesPage({ settings }: Props) {
  const client = useMemo(() => createCloudClient(settings.cloudApiBaseUrl), [settings.cloudApiBaseUrl]);
  const [features, setFeatures] = useState<AdminFeatureFlag[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [updatingKey, setUpdatingKey] = useState<string | null>(null);

  const fetchFeatures = useCallback(async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await client.adminListFeatures();
      setFeatures(result.features);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  const toggleRole = async (feature: AdminFeatureFlag, role: "member" | "beta" | "admin") => {
    setUpdatingKey(feature.key);
    const currentRoles = feature.default_roles;
    const newRoles = currentRoles.includes(role)
      ? currentRoles.filter((r) => r !== role)
      : [...currentRoles, role];

    try {
      const result = await client.adminUpdateFeature(feature.key, { defaultRoles: newRoles as ("member" | "beta" | "admin")[] });
      setFeatures((prev) => prev.map((f) => (f.key === feature.key ? result.feature : f)));
      setMessage("功能角色已更新");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingKey(null);
    }
  };

  const toggleActive = async (feature: AdminFeatureFlag) => {
    setUpdatingKey(feature.key);
    try {
      const result = await client.adminUpdateFeature(feature.key, { isActive: !feature.is_active });
      setFeatures((prev) => prev.map((f) => (f.key === feature.key ? result.feature : f)));
      setMessage(feature.is_active ? "功能已下线" : "功能已上线");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setUpdatingKey(null);
    }
  };

  // 按模块分组
  const grouped = useMemo(() => {
    const groups: Record<string, AdminFeatureFlag[]> = {};
    for (const f of features) {
      if (!groups[f.module]) groups[f.module] = [];
      groups[f.module].push(f);
    }
    return groups;
  }, [features]);

  const MODULE_LABELS: Record<string, string> = {
    gallery: "素材图库",
    listing: "上架管理",
    admin: "管理后台",
  };

  return (
    <section className="panel" style={{ minHeight: "60vh" }}>
      <div className="panel-header">
        <div>
          <span className="eyebrow">RBAC 管理</span>
          <h2>功能开关</h2>
        </div>
        <button className="secondary-button" onClick={fetchFeatures} disabled={loading}>
          <RefreshCw size={15} className={loading ? "spin-icon" : undefined} />
          刷新
        </button>
      </div>

      {message ? <div className="alert" style={{ marginBottom: "12px" }}>{message}</div> : null}

      <p className="muted" style={{ fontSize: "12px", marginBottom: "16px" }}>
        勾选角色表示该角色默认可以访问此功能。个人授权可在「用户管理」页面单独配置。
      </p>

      {Object.entries(grouped).map(([module, moduleFeatures]) => (
        <div key={module} className="panel-subsection" style={{ marginBottom: "20px" }}>
          <h3 style={{ fontSize: "14px", marginBottom: "10px", color: "#374151" }}>
            {MODULE_LABELS[module] || module}
          </h3>
          <div style={{ overflowX: "auto" }}>
            <table className="data-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb" }}>
                  <th style={{ padding: "8px" }}>功能标识</th>
                  <th style={{ padding: "8px" }}>名称</th>
                  <th style={{ padding: "8px" }}>说明</th>
                  <th style={{ padding: "8px" }}>普通用户</th>
                  <th style={{ padding: "8px" }}>内测用户</th>
                  <th style={{ padding: "8px" }}>管理员</th>
                  <th style={{ padding: "8px" }}>状态</th>
                </tr>
              </thead>
              <tbody>
                {moduleFeatures.map((feature) => (
                  <tr key={feature.key} style={{ borderBottom: "1px solid #f0f0f0" }}>
                    <td style={{ padding: "8px" }}>
                      <code style={{ fontSize: "11px", background: "#f3f4f6", padding: "1px 4px", borderRadius: "2px" }}>
                        {feature.key}
                      </code>
                    </td>
                    <td style={{ padding: "8px" }}>{feature.label}</td>
                    <td style={{ padding: "8px", maxWidth: "200px" }}>
                      <span className="muted" style={{ fontSize: "12px" }}>{feature.description || "-"}</span>
                    </td>
                    {ALL_ROLES.map((role) => (
                      <td key={role} style={{ padding: "8px", textAlign: "center" }}>
                        <button
                          className="icon-button"
                          style={{ width: "auto", opacity: updatingKey === feature.key ? 0.5 : 1 }}
                          disabled={updatingKey === feature.key}
                          onClick={() => toggleRole(feature, role)}
                          title={`${ROLE_LABELS[role]} ${feature.default_roles.includes(role) ? "已启用" : "未启用"}`}
                        >
                          {feature.default_roles.includes(role) ? (
                            <ToggleRight size={24} color="#1677ff" />
                          ) : (
                            <ToggleLeft size={24} color="#d1d5db" />
                          )}
                        </button>
                      </td>
                    ))}
                    <td style={{ padding: "8px" }}>
                      <button
                        className={feature.is_active ? "badge" : "badge warn"}
                        style={{ cursor: "pointer", border: "none", fontSize: "12px" }}
                        disabled={updatingKey === feature.key}
                        onClick={() => toggleActive(feature)}
                      >
                        {feature.is_active ? "已上线" : "已下线"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {features.length === 0 && !loading ? (
        <div className="muted" style={{ textAlign: "center", padding: "40px" }}>暂无功能标识数据</div>
      ) : null}
    </section>
  );
}
