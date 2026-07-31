import { KeyRound, LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppSettings, CloudUser } from "@shared/types";
import { api } from "../../lib/api";
import { clearCloudToken, createCloudClient, getCloudToken, setCloudToken } from "../../lib/cloudApi";

interface Props {
  settings: AppSettings;
}

type AuthMode = "login" | "register";

export function LicensePage({ settings }: Props) {
  const client = useMemo(() => createCloudClient(settings.cloudApiBaseUrl), [settings.cloudApiBaseUrl]);
  const [authMode, setAuthMode] = useState<AuthMode>("login");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [redeemKey, setRedeemKey] = useState("");
  const [user, setUser] = useState<CloudUser | null>(null);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const signedIn = Boolean(getCloudToken());

  useEffect(() => {
    if (!signedIn) return;
    refreshMe().catch((error) => setMessage(readableError(error)));
  }, [signedIn, settings.cloudApiBaseUrl]);

  const refreshMe = async () => {
    const result = await client.me();
    setUser(result.user);
  };

  const submitAuth = async () => {
    if (!phone.trim() || !password.trim()) {
      setMessage("请填写手机号和密码。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const deviceFingerprint = await api.getDeviceFingerprint();
      const payload = {
        phone: phone.trim(),
        password,
        deviceFingerprint,
        deviceName: window.navigator.platform || "Ozon SJSQ",
      };
      const result = authMode === "login"
        ? await client.login(payload)
        : await client.register({ ...payload, licenseKey: licenseKey.trim() || undefined });
      setCloudToken(result.token);
      setUser(result.user);
      setMessage(authMode === "login" ? "登录成功。" : "注册成功。");
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setLoading(false);
    }
  };

  const testCloud = async () => {
    setLoading(true);
    setMessage("");
    try {
      const result = await client.health();
      setMessage(`云服务连接正常：${result.service}，时间 ${formatDate(result.time)}。`);
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setLoading(false);
    }
  };

  const redeem = async () => {
    if (!redeemKey.trim()) {
      setMessage("请先填写兑换密钥。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const result = await client.redeemLicense(redeemKey.trim());
      await refreshMe();
      setRedeemKey("");
      setMessage(`兑换成功，${result.membership.planLabel} 到期时间：${formatDate(result.membership.expiresAt)}。`);
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="content-grid">
      {message ? <section className="panel"><span className={isErrorMessage(message) ? "badge warn" : "badge"}>{message}</span></section> : null}

      <section className="panel license-panel">
        <div className="panel-header">
          <div>
            <h2>兑换密钥</h2>
            <p className="muted">在这里登录账号、查看会员状态，并兑换新的授权密钥。</p>
          </div>
          <div className="toolbar">
            <button className="secondary-button" disabled={loading} onClick={testCloud}>
              <RefreshCw size={15} className={loading ? "spin-icon" : undefined} /> 测试云服务
            </button>
            {signedIn ? <button className="secondary-button" onClick={() => {
              clearCloudToken();
              setUser(null);
              setMessage("已退出账号。");
            }}>退出登录</button> : null}
          </div>
        </div>

        {!signedIn ? (
          <>
            <div className="tabs">
              <button className={authMode === "login" ? "tab active" : "tab"} onClick={() => setAuthMode("login")}>登录</button>
              <button className={authMode === "register" ? "tab active" : "tab"} onClick={() => setAuthMode("register")}>注册</button>
            </div>
            <div className="form-grid" style={{ marginTop: 8 }}>
              <div className="field">
                <label>手机号</label>
                <input value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="username" />
              </div>
              <div className="field">
                <label>密码</label>
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
              </div>
              {authMode === "register" ? (
                <div className="field">
                  <label>注册授权密钥</label>
                  <input value={licenseKey} onChange={(event) => setLicenseKey(event.target.value)} placeholder="OSJ-..." />
                </div>
              ) : null}
            </div>
            <div className="toolbar" style={{ marginTop: 8 }}>
              <button className="primary-button" disabled={loading} onClick={submitAuth}>
                <LogIn size={15} /> {authMode === "login" ? "登录" : "注册并登录"}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="overview-status-grid">
              <div className="status-block">
                <span>账号</span>
                <strong>{user?.phone ?? "已登录"}</strong>
              </div>
              <div className="status-block">
                <span>会员</span>
                <strong>{membershipLabel(user)}</strong>
              </div>
              <div className="status-block wide">
                <span>到期时间</span>
                <strong>{user?.membershipExpiresAt ? formatDate(user.membershipExpiresAt) : "未开通"}</strong>
              </div>
              <div className="status-block">
                <span>设备</span>
                <strong>本机已绑定</strong>
              </div>
            </div>
            <div className="license-redeem-row">
              <div className="field">
                <label>兑换密钥</label>
                <input value={redeemKey} onChange={(event) => setRedeemKey(event.target.value)} placeholder="OSJ-..." />
              </div>
              <button className="primary-button" disabled={loading} onClick={redeem}>
                <KeyRound size={15} /> 兑换
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <div className="status-row">
          <ShieldCheck size={18} className="ok-icon" />
          <strong>安全边界</strong>
        </div>
        <p className="muted">兑换密钥只发送到云服务验证；Ozon API Key、店铺 Cookie 和本机文件路径仍由本地助手处理。</p>
      </section>
    </div>
  );
}

function membershipLabel(user: CloudUser | null) {
  if (!user?.membershipExpiresAt) return "未开通";
  const expiresAt = new Date(user.membershipExpiresAt).getTime();
  return expiresAt > Date.now() ? planLabel(user.membershipPlan) : "已过期";
}

function planLabel(plan?: string | null) {
  if (plan === "monthly") return "月卡";
  if (plan === "quarterly") return "季卡";
  if (plan === "yearly") return "年卡";
  return "会员";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN");
}

function readableError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error:\s*/, "");
}

function isErrorMessage(message: string) {
  return message.includes("失败") || message.includes("错误") || message.includes("异常") || message.includes("Error");
}
