import { KeyRound, LogIn, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { AppSettings, CloudUser } from "@shared/types";
import { api } from "../../lib/api";
import {
  checkLocalAssistantWithGracePeriod,
  getCloudSyncStatus,
  resolveWebDeviceFingerprint,
  startCloudSync,
  type CloudSyncStatus,
} from "../../lib/localAssistant";
import {
  CLOUD_AUTH_CHANGED_EVENT,
  clearCloudToken,
  cloudAccountId,
  createCloudClient,
  getCloudToken,
  isAuthFailure,
  isMembershipRequired,
  setCloudToken,
} from "../../lib/cloudApi";

interface Props {
  settings: AppSettings;
  children: ReactNode;
}

interface CloudSyncGateProps extends Props {
  userId: string;
}

type AuthMode = "login" | "register";
type GateState = "checking" | "signed_out" | "active" | "expired";
type VerifyOptions = { silent?: boolean };
const SILENT_AUTH_FAILURE_LIMIT = 3;

export function AuthGate({ settings, children }: Props) {
  const client = useMemo(() => createCloudClient(settings.cloudApiBaseUrl), [settings.cloudApiBaseUrl]);
  const [mode, setMode] = useState<AuthMode>("login");
  const [state, setState] = useState<GateState>("checking");
  const [user, setUser] = useState<CloudUser | null>(null);
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [licenseKey, setLicenseKey] = useState("");
  const [redeemKey, setRedeemKey] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const stateRef = useRef<GateState>("checking");
  const userRef = useRef<CloudUser | null>(null);
  const lastVerifiedUserRef = useRef<CloudUser | null>(null);
  const silentAuthFailureCountRef = useRef(0);

  const setGateState = useCallback((nextState: GateState) => {
    stateRef.current = nextState;
    setState(nextState);
  }, []);

  const setCurrentUser = useCallback((nextUser: CloudUser | null) => {
    userRef.current = nextUser;
    if (nextUser && hasActiveMembership(nextUser)) {
      lastVerifiedUserRef.current = nextUser;
    }
    setUser(nextUser);
  }, []);

  const verifySession = useCallback(async (options: VerifyOptions = {}) => {
    const token = getCloudToken();
    if (!token) {
      lastVerifiedUserRef.current = null;
      setCurrentUser(null);
      setGateState("signed_out");
      return;
    }
    if (!options.silent && stateRef.current !== "active") {
      setGateState("checking");
    }
    try {
      const result = await client.me();
      silentAuthFailureCountRef.current = 0;
      setCurrentUser(result.user);
      setGateState(hasActiveMembership(result.user) ? "active" : "expired");
      setMessage("");
    } catch (error) {
      if (isAuthFailure(error)) {
        const cachedUser = userRef.current ?? lastVerifiedUserRef.current;
        const canKeepCurrentPage = options.silent && (stateRef.current === "active" || Boolean(cachedUser && hasActiveMembership(cachedUser)));
        if (canKeepCurrentPage) {
          silentAuthFailureCountRef.current += 1;
          if (silentAuthFailureCountRef.current < SILENT_AUTH_FAILURE_LIMIT) {
            if (cachedUser) {
              setCurrentUser(cachedUser);
            }
            setGateState("active");
            setMessage(`登录状态校验临时失败，已保留当前页面，系统会自动重试：${readableError(error)}`);
            return;
          }
        }
        clearCloudToken();
        silentAuthFailureCountRef.current = 0;
        lastVerifiedUserRef.current = null;
        setCurrentUser(null);
        setGateState("signed_out");
        setMessage(readableError(error));
        return;
      }
      if (isMembershipRequired(error)) {
        silentAuthFailureCountRef.current = 0;
        setGateState("expired");
        setMessage(readableError(error));
        return;
      }
      silentAuthFailureCountRef.current = 0;
      const cachedUser = userRef.current ?? lastVerifiedUserRef.current;
      const canKeepCurrentPage = stateRef.current === "active" || Boolean(cachedUser && hasActiveMembership(cachedUser));
      if (canKeepCurrentPage) {
        if (cachedUser) {
          setCurrentUser(cachedUser);
        }
        setGateState("active");
        setMessage(`网络异常，暂时无法验证登录状态，当前页面可继续使用：${readableError(error)}`);
        return;
      }
      if (options.silent) {
        setMessage(`网络异常，暂时无法验证登录状态，当前页面可继续使用：${readableError(error)}`);
        return;
      }
      setCurrentUser(null);
      setGateState("signed_out");
      setMessage(`无法验证登录状态：${readableError(error)}`);
    }
  }, [client, setCurrentUser, setGateState]);

  useEffect(() => {
    verifySession().catch((error) => {
      const cachedUser = userRef.current ?? lastVerifiedUserRef.current;
      if (cachedUser && hasActiveMembership(cachedUser)) {
        setCurrentUser(cachedUser);
        setGateState("active");
      } else {
        setCurrentUser(null);
        setGateState("signed_out");
      }
      setMessage(readableError(error));
    });
  }, [setCurrentUser, setGateState, verifySession]);

  useEffect(() => {
    const handleAuthChanged = () => {
      if (!getCloudToken()) {
        lastVerifiedUserRef.current = null;
        setCurrentUser(null);
        setGateState("signed_out");
        return;
      }
      verifySession({ silent: true }).catch((error) => {
        setMessage(`网络异常，暂时无法验证登录状态，当前页面可继续使用：${readableError(error)}`);
      });
    };
    window.addEventListener(CLOUD_AUTH_CHANGED_EVENT, handleAuthChanged);
    return () => window.removeEventListener(CLOUD_AUTH_CHANGED_EVENT, handleAuthChanged);
  }, [setCurrentUser, setGateState, verifySession]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (getCloudToken()) {
        verifySession({ silent: true }).catch(() => undefined);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [verifySession]);

  const submitAuth = async () => {
    if (!phone.trim() || !password.trim()) {
      setMessage("请填写手机号和密码。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const assistant = await checkLocalAssistantWithGracePeriod();
      const deviceFingerprint = assistant.connected ? await api.getDeviceFingerprint() : await resolveWebDeviceFingerprint(assistant);
      const payload = {
        phone: phone.trim(),
        password,
        deviceFingerprint,
        deviceName: assistant.connected ? "Ozon SJSQ 本地助手" : window.navigator.platform || "网页端",
      };
      const result = mode === "login"
        ? await client.login(payload)
        : await client.register({ ...payload, licenseKey: licenseKey.trim() || undefined });
      setCurrentUser(result.user);
      setGateState(hasActiveMembership(result.user) ? "active" : "expired");
      setCloudToken(result.token);
      setMessage(hasActiveMembership(result.user) ? "登录成功。" : "登录成功，请兑换授权密钥后继续使用。");
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setLoading(false);
    }
  };

  const redeem = async () => {
    if (!redeemKey.trim()) {
      setMessage("请填写授权密钥。");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      await client.redeemLicense(redeemKey.trim());
      setRedeemKey("");
      await verifySession();
      setMessage("授权成功，会员已开通。");
    } catch (error) {
      setMessage(readableError(error));
    } finally {
      setLoading(false);
    }
  };

  if (state === "active") {
    return <CloudSyncGate settings={settings} userId={user?.id ?? ""}>{children}</CloudSyncGate>;
  }

  return (
    <div className="auth-shell">
      <section className="auth-panel">
        <div className="auth-brand">
          <ShieldCheck size={34} />
          <div>
            <strong>Ozon SJSQ</strong>
            <span>会员授权登录</span>
          </div>
        </div>

        {state === "checking" ? (
          <div className="auth-loading">
            <RefreshCw size={20} />
            <span>正在验证会员状态...</span>
          </div>
        ) : (
          <>
            <div className="tabs">
              <button className={mode === "login" ? "tab active" : "tab"} onClick={() => setMode("login")}>登录</button>
              <button className={mode === "register" ? "tab active" : "tab"} onClick={() => setMode("register")}>注册</button>
            </div>
            <div className="form-grid auth-form-grid">
              <div className="field">
                <label>手机号</label>
                <input value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="username" />
              </div>
              <div className="field">
                <label>密码</label>
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
              </div>
              {mode === "register" ? (
                <div className="field full">
                  <label>授权密钥</label>
                  <input value={licenseKey} onChange={(event) => setLicenseKey(event.target.value)} placeholder="OSJ-..." />
                </div>
              ) : null}
            </div>
            <button className="primary-button auth-submit" disabled={loading} onClick={submitAuth}>
              <LogIn size={16} /> {mode === "login" ? "登录软件" : "注册并登录"}
            </button>

            {user ? (
              <div className="auth-renew-box">
                <strong>{user.phone}</strong>
                <span>{user.membershipExpiresAt ? `会员到期：${formatDate(user.membershipExpiresAt)}` : "当前账号还没有开通会员。"}</span>
                <div className="field">
                  <label>授权密钥</label>
                  <input value={redeemKey} onChange={(event) => setRedeemKey(event.target.value)} placeholder="OSJ-..." />
                </div>
                <div className="toolbar">
                  <button className="primary-button" disabled={loading} onClick={redeem}>
                    <KeyRound size={15} /> 兑换并进入
                  </button>
                  <button className="secondary-button" onClick={() => {
                    clearCloudToken();
                    lastVerifiedUserRef.current = null;
                    setCurrentUser(null);
                    setGateState("signed_out");
                  }}>退出账号</button>
                </div>
              </div>
            ) : null}
          </>
        )}

        {message ? <div className={message.includes("成功") ? "auth-message ok" : "auth-message"}>{message}</div> : null}
        <p className="auth-footnote">一个账号只能绑定一台机器。换电脑使用前，需要管理员在后台解绑设备。</p>
      </section>
    </div>
  );
}

function CloudSyncGate({ settings, children, userId }: CloudSyncGateProps) {
  const [ready, setReady] = useState(false);
  const [statuses, setStatuses] = useState<CloudSyncStatus[]>([]);
  const [message, setMessage] = useState("正在初始化本地加密数据...");
  const token = getCloudToken();
  const accountId = userId || cloudAccountId(token);

  const refreshStatus = useCallback(async () => {
    if (!accountId) {
      throw new Error("登录凭证缺少账号标识，请重新登录");
    }
    const next = await getCloudSyncStatus(accountId);
    setStatuses(next);
    const required = next.filter((item) => item.scope === "gallery" || item.scope === "featured");
    const completed = required.length === 2 && required.every((item) => item.completed);
    setReady(completed);
    if (completed) {
      setMessage("本地数据已就绪");
    } else {
      const error = required.find((item) => item.lastError && !item.syncing)?.lastError;
      setMessage(error || "正在同步图库元数据，首次同步完成前暂不开放业务操作...");
    }
    return completed;
  }, [accountId]);

  const beginSync = useCallback(async () => {
    if (!accountId || !token) {
      throw new Error("登录状态无效，请重新登录");
    }
    await startCloudSync({ baseUrl: settings.cloudApiBaseUrl, authToken: token, accountId });
  }, [accountId, settings.cloudApiBaseUrl, token]);

  useEffect(() => {
    let disposed = false;
    let timer = 0;
    const run = async () => {
      try {
        const completed = await refreshStatus();
        await beginSync();
        if (!disposed && !completed) {
          timer = window.setInterval(() => {
            refreshStatus().catch((error) => setMessage(readableError(error)));
          }, 1000);
        }
      } catch (error) {
        if (!disposed) setMessage(readableError(error));
      }
    };
    void run();
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [beginSync, refreshStatus]);

  useEffect(() => {
    if (!ready) return undefined;
    const initialDelay = 10 * 60_000 + Math.floor(Math.random() * 3 * 60_000);
    const timer = window.setTimeout(() => {
      beginSync().catch(() => undefined);
    }, initialDelay);
    return () => window.clearTimeout(timer);
  }, [beginSync, ready]);

  const syncing = statuses.some((item) => item.syncing);
  return (
    <>
      {children}
      {!ready ? (
        <div className="cloud-sync-notice">
          <RefreshCw size={16} className={syncing ? "spin-icon" : undefined} />
          <div>
            <strong>图库数据正在后台同步</strong>
            <span>{syncing ? "同步完成前自动使用云端数据，不影响正常操作" : message}</span>
          </div>
          {!syncing ? (
            <button className="secondary-button" onClick={() => beginSync().catch((error) => setMessage(readableError(error)))}>
              重新同步
            </button>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function hasActiveMembership(user: CloudUser | null) {
  if (!user?.membershipExpiresAt) return false;
  return new Date(user.membershipExpiresAt).getTime() > Date.now();
}

function readableError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "");
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN");
}
