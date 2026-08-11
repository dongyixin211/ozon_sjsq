import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Boxes,
  CheckCircle2,
  ClipboardList,
  ExternalLink,
  FileText,
  Home,
  Images,
  MonitorUp,
  RefreshCw,
  ShoppingBag,
  WifiOff,
} from "lucide-react";
import type { AiSettingsPublic, AppSettings, Shop } from "@shared/types";
import { api, defaultSettings, type AppSnapshot } from "./lib/api";
import { CLOUD_AUTH_CHANGED_EVENT, cloudAccountId, createCloudClient, getCloudToken } from "./lib/cloudApi";
import {
  checkLocalAssistant,
  checkLocalAssistantWithGracePeriod,
  preserveAssistantDuringTransientFailure,
  LOCAL_ASSISTANT_PROTOCOL_VERSION,
  openLocalAssistant,
  type LocalAssistantStatus,
} from "./lib/localAssistant";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { MaterialsPage } from "./features/materials/MaterialsPage";
import { OzonPage } from "./features/ozon/OzonPage";
import { OrdersPage } from "./features/orders/OrdersPage";
import { JobsPage } from "./features/jobs/JobsPage";
import { CloudPage } from "./features/cloud/CloudPage";
import { LicensePage } from "./features/cloud/LicensePage";
import { AuthGate } from "./features/auth/AuthGate";
import { checkDesktopUpdate, installDesktopUpdate } from "./lib/updater";
import { WorkspaceModuleTabs } from "./workspace/WorkspaceModuleTabs";
import { moduleForPage, workspaceModules, type PageKey, type WorkspaceModuleKey } from "./workspace/navigation";
import { filterModulesByFeatures, canAccessPage } from "./workspace/featurePermissions";
import { useFeatures } from "./lib/featuresContext";

import { AutoListingPlansPage } from './features/cloud/AutoListingPlansPage';
import { AdminUsersPage } from './features/admin/AdminUsersPage';
import { AdminFeaturesPage } from './features/admin/AdminFeaturesPage';
import { AdminLogsPage } from './features/admin/AdminLogsPage';

const workspaceModuleIcons: Record<WorkspaceModuleKey, typeof Home> = {
  home: Home,
  assets: Images,
  listing: ShoppingBag,
  orders: FileText,
  tasks: ClipboardList,
};

const WEB_WORKSPACE_URL = "https://api.dyxtoolai.cn/app/";
const ASSISTANT_CHECKING_STATUS: LocalAssistantStatus = { connected: false, state: "checking" };

export function App() {
  if (isTauriRuntime()) {
    return <LocalAssistantShell />;
  }

  const [page, setPage] = useState<PageKey>("dashboard");
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [message, setMessage] = useState<string>("");
  const [selectedJobId, setSelectedJobId] = useState<string>("");
  const [assistant, setAssistant] = useState<LocalAssistantStatus>(ASSISTANT_CHECKING_STATUS);
  const [cloudAiSettings, setCloudAiSettings] = useState<AiSettingsPublic | null>(null);
  const [ozonHomeRequest, setOzonHomeRequest] = useState(0);
  const [pageHeaderExtra, setPageHeaderExtra] = useState<React.ReactNode>(null);

  // RBAC: 根据用户功能权限过滤菜单
  const { features } = useFeatures();
  const visibleModules = useMemo(
    () => filterModulesByFeatures(workspaceModules, features),
    [features],
  );

  // 权限守卫: 如果当前页面不可访问，自动跳转到首页
  useEffect(() => {
    if (!canAccessPage(features, page)) {
      setPage("dashboard");
    }
  }, [features, page]);
  const assistantProbeFailures = useRef(0);
  const assistantConnectionError = useRef("");
  const lastHealthyAssistant = useRef<LocalAssistantStatus>(ASSISTANT_CHECKING_STATUS);
  const schedulerRegistrationKey = useRef("");

  const refresh = async () => {
    setAssistant((current) => (current.connected ? current : ASSISTANT_CHECKING_STATUS));
    const assistantStatus = await checkLocalAssistantWithGracePeriod();
    setAssistant(assistantStatus);

    if (!assistantStatus.connected) {
      const errorMessage = assistantStatus.error || "本地助手未连接";
      assistantConnectionError.current = errorMessage;
      setMessage(errorMessage);
      return;
    }

    try {
      const next = await api.loadAppState();
      setSnapshot(next);
      setMessage("");
    } catch (error) {
      setMessage(readableError(error));
    }
  };

  const refreshCloudAiSettings = async () => {
    const token = getCloudToken();
    if (!token) {
      setCloudAiSettings(null);
      return;
    }
    try {
      const result = await createCloudClient(defaultSettings.cloudApiBaseUrl).getAiSettings();
      setCloudAiSettings(result.settings);
    } catch {
      setCloudAiSettings(null);
    }
  };

  useEffect(() => {
    refresh().catch((error) => {
      setMessage(readableError(error));
    });
    refreshCloudAiSettings().catch(() => undefined);
  }, []);

  useEffect(() => {
    let disposed = false;
    let timer: number | undefined;

    const scheduleProbe = (delayMs: number) => {
      timer = window.setTimeout(() => {
        void probe();
      }, delayMs);
    };

    const probe = async () => {
      try {
        const status = await checkLocalAssistant();
        if (disposed) return;
        const healthy = status.connected && status.compatible !== false;
        if (healthy) {
          assistantProbeFailures.current = 0;
          setAssistant(status);
          if (assistantConnectionError.current) {
            const previousError = assistantConnectionError.current;
            setMessage((current) => current === previousError ? "" : current);
            assistantConnectionError.current = "";
          }
          if (!snapshot) {
            refresh().catch((error) => setMessage(readableError(error)));
            refreshCloudAiSettings().catch(() => undefined);
          }
          scheduleProbe(10_000);
          return;
        }

        assistantProbeFailures.current += 1;
        const displayStatus = preserveAssistantDuringTransientFailure(
          lastHealthyAssistant.current,
          status,
          assistantProbeFailures.current,
        );
        if (assistantProbeFailures.current >= 5) {
          setAssistant(displayStatus);
          const errorMessage = status.error || "本地助手未连接";
          assistantConnectionError.current = errorMessage;
          setMessage(errorMessage);
        } else {
          setAssistant(displayStatus);
        }
        scheduleProbe(2_000);
      } catch {
        if (!disposed) scheduleProbe(2_000);
      }
    };

    scheduleProbe(assistant.connected && assistant.compatible !== false ? 10_000 : 2_000);
    return () => {
      disposed = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [snapshot]);

  useEffect(() => {
    const handleAuthChanged = () => {
      refreshCloudAiSettings().catch(() => undefined);
    };
    window.addEventListener(CLOUD_AUTH_CHANGED_EVENT, handleAuthChanged);
    return () => window.removeEventListener(CLOUD_AUTH_CHANGED_EVENT, handleAuthChanged);
  }, []);

  const runningCount = useMemo(
    () => snapshot?.jobs.filter((job) => job.status === "running" || job.status === "queued").length ?? 0,
    [snapshot],
  );

  useEffect(() => {
    if (runningCount === 0) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      refresh().catch((error) => setMessage(String(error)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [runningCount]);

  const shops = useMemo(() => sortShopsByName(snapshot?.shops ?? []), [snapshot?.shops]);
  const jobs = snapshot?.jobs ?? [];
  const settings = applyCloudAiSettings(snapshot?.settings ?? defaultSettings, cloudAiSettings);
  const assistantConnected = assistant.connected && assistant.compatible !== false;
  const assistantChecking = !assistant.connected && assistant.state === "checking";
  const cloudAuthToken = getCloudToken();
  const accountId = cloudAccountId(cloudAuthToken);
  const pageTitle = navLabelForPage(page);
  const currentMaterialMode = materialModeFromPage(page);
  const currentImageMode = imageModeFromPage(page);
  const currentModule = moduleForPage(page);

  useEffect(() => {
    if (!assistantConnected || !cloudAuthToken || !accountId) {
      schedulerRegistrationKey.current = "";
      return;
    }
    const registrationKey = `${accountId}:${settings.cloudApiBaseUrl}`;
    if (schedulerRegistrationKey.current === registrationKey) {
      return;
    }
    schedulerRegistrationKey.current = registrationKey;
    api.runAutoListingPlanNow({
      accountId,
      cloudApiBaseUrl: settings.cloudApiBaseUrl,
      cloudAuthToken,
      force: false,
    }).catch((error) => {
      setMessage(`自动上品调度注册失败：${readableError(error)}`);
    });
  }, [accountId, assistantConnected, cloudAuthToken, settings.cloudApiBaseUrl]);

  useEffect(() => {
    if (page !== "ozon") setPageHeaderExtra(null);
  }, [page]);

  const navigate = (nextPage: PageKey) => {
    setPage(nextPage);
    if (nextPage === "ozon") {
      setOzonHomeRequest((value) => value + 1);
    }
  };

  const appContent = (
    <div className="app-shell web-app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Boxes size={28} />
          <div>
            <strong>Ozon SJSQ</strong>
            <span>商品素材与上架工作台</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="主模块">
          <div className="nav-list-main">
            {visibleModules.map((module) => {
              const Icon = workspaceModuleIcons[module.key];
              const active = module.key === currentModule.key;
              return (
                <button
                  type="button"
                  className={active ? "nav-item nav-parent active" : "nav-item nav-parent"}
                  key={module.key}
                  title={module.label}
                  onClick={() => navigate(module.pages[0].key)}
                >
                  <Icon size={18} />
                  <span>{module.label}</span>
                </button>
              );
            })}
          </div>
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="eyebrow">浏览器工作台</span>
            <h1>{pageTitle}</h1>
          </div>
          <div className="topbar-page-context">{pageHeaderExtra}</div>
          <div className="topbar-actions">
            <span className={assistantConnected ? "status-pill" : assistantChecking ? "badge neutral" : "badge warn"}>
              {assistantConnected ? <MonitorUp size={14} /> : assistantChecking ? <RefreshCw size={14} className="spin-icon" /> : <WifiOff size={14} />}
              {assistantConnected ? "本地助手已连接" : assistantChecking ? "本地助手连接中" : "本地助手未连接"}
            </span>
            <button className="secondary-button" onClick={() => openWebWorkspace()}>
              打开浏览器工作台
            </button>
            <span className="status-pill">{runningCount} 个任务运行中</span>
            <button className="icon-button" onClick={() => refresh().catch((error) => setMessage(String(error)))} title="刷新">
              <RefreshCw size={18} />
            </button>
          </div>
        </header>

        <WorkspaceModuleTabs page={page} onNavigate={navigate} />

        {page === 'autoListingPlans' && settings ? (
          <AutoListingPlansPage
            shops={shops}
            settings={settings}
            accountId={accountId}
            cloudAuthToken={cloudAuthToken}
            onNavigate={navigate}
            onMessage={setMessage}
          />
        ) : null}

        {message ? <div className="alert">{message}</div> : null}
        {!assistantConnected ? (
          <section className="panel assistant-panel">
            <div className="status-row">
              {assistantChecking ? <RefreshCw size={18} className="spin-icon ok-icon" /> : <WifiOff size={18} className="bad-icon" />}
              <strong>{assistantChecking ? "本地助手连接中" : "本地助手未连接"}</strong>
            </div>
            <p className="muted">
              {assistantChecking
                ? "客户端刚启动时需要一点时间完成探测，完整功能入口稍后会自动可用。"
                : "账号、会员和云图库可在浏览器使用；上架、更新库存、订单下载、目录选择和 Ozon 密钥相关功能需要先打开客户端。"}
            </p>
          </section>
        ) : null}

        {page === "dashboard" && settings && (
          <DashboardPage
            shops={shops}
            jobs={jobs}
            settings={settings}
            providerSecrets={cloudAiSettings
              ? {
                  imageApiKeyStored: cloudAiSettings.imageApiKeyStored,
                  textApiKeyStored: cloudAiSettings.textApiKeyStored,
                }
              : snapshot?.providerSecrets ?? { imageApiKeyStored: false, textApiKeyStored: false }}
            onNavigate={navigate}
            onOpenJobLogs={(jobId) => {
              setSelectedJobId(jobId);
              setPage("jobs");
            }}
          />
        )}
        {currentMaterialMode && settings && (
          <MaterialsPage
            mode={currentMaterialMode}
            settings={settings}
            onChanged={refresh}
            onJobStarted={refresh}
          />
        )}
        {page === "ozon" && settings && (
          <OzonPage
            shops={shops}
            jobs={jobs}
            settings={settings}
            homeRequest={ozonHomeRequest}
            onChanged={refresh}
            onNavigate={navigate}
            onHeaderChange={setPageHeaderExtra}
          />
        )}
        {page === "orders" && settings && <OrdersPage shops={shops} settings={settings} onChanged={refresh} onNavigate={navigate} />}
        {page === "jobs" && <JobsPage jobs={jobs} selectedJobId={selectedJobId} cloudApiBaseUrl={settings.cloudApiBaseUrl} onChanged={refresh} />}
        {currentImageMode && settings && <CloudPage shops={shops} settings={settings} mode={currentImageMode} onNavigate={navigate} onChanged={refresh} />}
        {page === "license" && settings && <LicensePage settings={settings} />}
        {page === "adminUsers" && settings && <AdminUsersPage settings={settings} />}
        {page === "adminFeatures" && settings && <AdminFeaturesPage settings={settings} />}
        {page === "adminLogs" && settings && <AdminLogsPage settings={settings} />}
      </main>
    </div>
  );

  return <AuthGate settings={settings}>{appContent}</AuthGate>;
}

function AssistantRequiredGate({
  status,
  onRetry,
}: {
  status: LocalAssistantStatus;
  onRetry: () => Promise<void>;
}) {
  const incompatible = status.connected && status.compatible === false;
  return (
    <main className="assistant-required-shell">
      <section className="assistant-required-panel">
        <div className="assistant-logo"><MonitorUp size={24} /></div>
        <span className="eyebrow">浏览器工作台</span>
        <h1>{incompatible ? "请更新客户端助手" : "请先打开客户端助手"}</h1>
        <p>
          {incompatible
            ? `当前助手协议版本为 ${status.protocolVersion || "未知"}，网页需要版本 ${LOCAL_ASSISTANT_PROTOCOL_VERSION}。更新完成后会自动进入工作台。`
            : "商品、图库、订单和任务数据全部由本地助手安全处理。检测到助手运行后，本页面会自动进入工作台。"}
        </p>
        {status.error ? <div className="assistant-required-error">{status.error}</div> : null}
        <div className="assistant-actions">
          <button className="primary-button" onClick={openLocalAssistant}>
            <MonitorUp size={16} /> {incompatible ? "打开客户端更新" : "打开客户端助手"}
          </button>
          <button className="secondary-button" onClick={() => onRetry().catch(() => undefined)}>
            <RefreshCw size={16} /> 重新检测
          </button>
        </div>
      </section>
    </main>
  );
}

function LocalAssistantShell() {
  const [checking, setChecking] = useState(true);
  const [cloudStatus, setCloudStatus] = useState<"checking" | "ok" | "error">("checking");
  const [cloudMessage, setCloudMessage] = useState("正在检测浏览器工作台链接");
  const [checkedAt, setCheckedAt] = useState("");
  const [availableUpdate, setAvailableUpdate] = useState<Awaited<ReturnType<typeof checkDesktopUpdate>>["update"]>(null);
  const [updateMessage, setUpdateMessage] = useState("正在检查客户端更新");
  const [updating, setUpdating] = useState(false);

  const refreshStatus = async () => {
    setChecking(true);
    setCloudStatus("checking");
    setCloudMessage("正在检测浏览器工作台链接");
    try {
      await createCloudClient(defaultSettings.cloudApiBaseUrl).health();
      setCloudStatus("ok");
      setCloudMessage("链接正常，可以在浏览器打开工作台");
    } catch (error) {
      setCloudStatus("error");
      setCloudMessage(`链接异常：${readableError(error)}`);
    } finally {
      setCheckedAt(new Date().toLocaleString("zh-CN", { hour12: false }));
      setChecking(false);
    }
  };

  useEffect(() => {
    refreshStatus().catch((error) => {
      setCloudStatus("error");
      setCloudMessage(`链接异常：${readableError(error)}`);
      setCheckedAt(new Date().toLocaleString("zh-CN", { hour12: false }));
      setChecking(false);
    });
  }, []);

  const installUpdate = async () => {
    if (!availableUpdate || updating) return;
    setUpdating(true);
    setUpdateMessage(`正在下载 ${availableUpdate.version}...`);
    try {
      await installDesktopUpdate(availableUpdate, (event) => {
        if (event.event === "Started") setUpdateMessage(`正在下载 ${availableUpdate.version}...`);
        if (event.event === "Finished") setUpdateMessage("下载完成，正在安装并重启...");
      });
    } catch (error) {
      setUpdateMessage(`更新失败：${readableError(error)}`);
      setUpdating(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => {
      checkDesktopUpdate().then(async ({ update, required }) => {
        if (!update) {
          setUpdateMessage("当前已是最新版本");
          return;
        }
        setAvailableUpdate(update);
        setUpdateMessage(`发现新版本 ${update.version}${required ? "，需要立即更新" : ""}`);
        if (required) {
          await installDesktopUpdate(update);
        }
      }).catch((error) => setUpdateMessage(`更新检查失败：${readableError(error)}`));
    }, 1200);
    return () => window.clearTimeout(timer);
  }, []);

  const StatusIcon = cloudStatus === "ok" ? CheckCircle2 : cloudStatus === "error" ? AlertTriangle : RefreshCw;

  return (
    <main className="assistant-shell">
      <section className="assistant-status-panel">
        <div className="assistant-status-header">
          <div className="assistant-logo">
            <Boxes size={24} />
          </div>
          <div>
            <span className="eyebrow">本地助手客户端</span>
            <h1>Ozon SJSQ</h1>
          </div>
        </div>

        <div className="assistant-status-list">
          <div className="assistant-status-row">
            <span className="assistant-status-icon is-ok">
              <MonitorUp size={18} />
            </span>
            <div>
              <strong>本地助手运行中</strong>
              <span>本机文件、密钥和后台任务由客户端安全处理</span>
            </div>
          </div>
          <div className="assistant-status-row">
            <span className={`assistant-status-icon is-${cloudStatus}`}>
              <StatusIcon size={18} className={checking ? "spin-icon" : undefined} />
            </span>
            <div>
              <strong>浏览器工作台{cloudStatus === "ok" ? "链接正常" : cloudStatus === "error" ? "链接异常" : "检测中"}</strong>
              <span>{cloudMessage}</span>
            </div>
          </div>
        </div>

        <div className="assistant-link-box">
          <span>{WEB_WORKSPACE_URL}</span>
        </div>

        <div className="assistant-update-row">
          <span>{updateMessage}</span>
          {availableUpdate ? (
            <button className="secondary-button" onClick={() => installUpdate()} disabled={updating}>
              <RefreshCw size={15} className={updating ? "spin-icon" : undefined} />
              {updating ? "更新中" : "立即更新"}
            </button>
          ) : null}
        </div>

        <div className="assistant-actions">
          <button className="primary-button" onClick={openWebWorkspace}>
            <ExternalLink size={16} />
            打开浏览器工作台
          </button>
          <button className="secondary-button" onClick={() => refreshStatus()} disabled={checking}>
            <RefreshCw size={16} className={checking ? "spin-icon" : undefined} />
            重新检测
          </button>
        </div>

        <p className="assistant-footnote">{checkedAt ? `最近检测：${checkedAt}` : "启动后会自动检测链接状态"}</p>
      </section>
    </main>
  );
}

function sortShopsByName(shops: Shop[]) {
  return [...shops].sort((left, right) => (
    left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" })
    || left.clientId.localeCompare(right.clientId, "zh-CN", { numeric: true, sensitivity: "base" })
    || left.id.localeCompare(right.id)
  ));
}

function materialModeFromPage(page: PageKey) {
  if (page === "materialPortrait") return "portrait";
  if (page === "materialAiImage") return "aiImage";
  if (page === "materialTitle") return "title";
  if (page === "materialRename") return "rename";
  return null;
}

function imageModeFromPage(page: PageKey) {
  if (page === "imageUpload") return "upload";
  if (page === "imagePending") return "pending";
  if (page === "imageProcessing") return "processing";
  if (page === "imageUploaded") return "uploaded";
  if (page === "imageFeatured") return "featured";
  return null;
}

function navLabelForPage(page: PageKey) {
  for (const module of workspaceModules) {
    const item = module.pages.find((candidate) => candidate.key === page);
    if (item) return item.label;
  }
  return "首页";
}

function applyCloudAiSettings(settings: AppSettings, cloudAiSettings: AiSettingsPublic | null): AppSettings {
  if (!cloudAiSettings) {
    return settings;
  }
  return {
    ...settings,
    imageProvider: "cloud-proxy",
    textProvider: "cloud-proxy",
    imageBaseUrl: settings.cloudApiBaseUrl || defaultSettings.cloudApiBaseUrl,
    textBaseUrl: settings.cloudApiBaseUrl || defaultSettings.cloudApiBaseUrl,
    imageModel: cloudAiSettings.imageModel || settings.imageModel,
    textModel: cloudAiSettings.textModel || settings.textModel,
    imagePromptTemplate: cloudAiSettings.imagePromptTemplate || settings.imagePromptTemplate,
    titlePromptTemplate: cloudAiSettings.titlePromptTemplate || settings.titlePromptTemplate,
    descriptionPromptTemplate: cloudAiSettings.descriptionPromptTemplate || settings.descriptionPromptTemplate,
  };
}

function isTauriRuntime() {
  return "__TAURI_INTERNALS__" in window;
}

function readableError(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error:\s*/, "");
}

function openWebWorkspace() {
  const url = WEB_WORKSPACE_URL;
  if (isTauriRuntime()) {
    api.openUrl(url).catch(() => window.open(url, "_blank", "noopener,noreferrer"));
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
