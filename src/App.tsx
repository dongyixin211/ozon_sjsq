import { useEffect, useMemo, useState } from "react";
import {
  Boxes,
  ClipboardList,
  FileText,
  Home,
  Images,
  RefreshCw,
  Settings,
  ShoppingBag,
} from "lucide-react";
import type { AppSettings, JobSummary, Shop } from "@shared/types";
import { api, type AppSnapshot } from "./lib/api";
import { DashboardPage } from "./features/dashboard/DashboardPage";
import { MaterialsPage } from "./features/materials/MaterialsPage";
import { OzonPage } from "./features/ozon/OzonPage";
import { OrdersPage } from "./features/orders/OrdersPage";
import { JobsPage } from "./features/jobs/JobsPage";
import { SettingsPage } from "./features/settings/SettingsPage";

type PageKey = "dashboard" | "materials" | "ozon" | "orders" | "jobs" | "settings";

const navItems: Array<{ key: PageKey; label: string; icon: typeof Home }> = [
  { key: "dashboard", label: "首页", icon: Home },
  { key: "materials", label: "素材生成", icon: Images },
  { key: "ozon", label: "上架运维", icon: ShoppingBag },
  { key: "orders", label: "订单查询", icon: FileText },
  { key: "jobs", label: "任务记录", icon: ClipboardList },
  { key: "settings", label: "设置", icon: Settings },
];

export function App() {
  const [page, setPage] = useState<PageKey>("dashboard");
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [message, setMessage] = useState<string>("");
  const [selectedJobId, setSelectedJobId] = useState<string>("");

  const refresh = async () => {
    const next = await api.loadAppState();
    setSnapshot(next);
  };

  useEffect(() => {
    refresh().catch((error) => setMessage(String(error)));
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

  const shops = snapshot?.shops ?? [];
  const jobs = snapshot?.jobs ?? [];
  const settings = snapshot?.settings;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Boxes size={28} />
          <div>
            <strong>Ozon SJSQ</strong>
            <span>商品素材与上架工作台</span>
          </div>
        </div>
        <nav className="nav-list">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={item.key === page ? "nav-item active" : "nav-item"}
                key={item.key}
                onClick={() => setPage(item.key)}
                title={item.label}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <span className="eyebrow">单机版</span>
            <h1>{navItems.find((item) => item.key === page)?.label}</h1>
          </div>
          <div className="topbar-actions">
            <span className="status-pill">{runningCount} 个任务运行中</span>
            <button className="icon-button" onClick={() => refresh().catch((error) => setMessage(String(error)))} title="刷新">
              <RefreshCw size={18} />
            </button>
          </div>
        </header>

        {message ? <div className="alert">{message}</div> : null}

        {page === "dashboard" && settings && (
          <DashboardPage
            shops={shops}
            jobs={jobs}
            settings={settings}
            providerSecrets={snapshot?.providerSecrets ?? { imageApiKeyStored: false, textApiKeyStored: false }}
            onNavigate={setPage}
            onOpenJobLogs={(jobId) => {
              setSelectedJobId(jobId);
              setPage("jobs");
            }}
          />
        )}
        {page === "materials" && settings && <MaterialsPage settings={settings} onChanged={refresh} onJobStarted={refresh} onNavigate={setPage} />}
        {page === "ozon" && settings && <OzonPage shops={shops} settings={settings} onChanged={refresh} onNavigate={setPage} />}
        {page === "orders" && settings && <OrdersPage shops={shops} settings={settings} onChanged={refresh} onNavigate={setPage} />}
        {page === "jobs" && <JobsPage jobs={jobs} selectedJobId={selectedJobId} onChanged={refresh} />}
        {page === "settings" && settings && (
          <SettingsPage
            settings={settings}
            shops={shops}
            providerSecrets={snapshot?.providerSecrets ?? { imageApiKeyStored: false, textApiKeyStored: false }}
            onChanged={refresh}
          />
        )}
      </main>
    </div>
  );
}
