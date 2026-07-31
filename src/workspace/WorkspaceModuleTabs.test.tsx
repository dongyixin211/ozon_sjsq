import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { api, defaultSettings } from "../lib/api";
import { cloudAccountId, getCloudToken } from "../lib/cloudApi";
import { checkLocalAssistant, checkLocalAssistantWithGracePeriod } from "../lib/localAssistant";
import { WorkspaceModuleTabs } from "./WorkspaceModuleTabs";

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      loadAppState: vi.fn().mockResolvedValue({
        settings: actual.defaultSettings,
        shops: [],
        jobs: [],
        providerSecrets: { imageApiKeyStored: false, textApiKeyStored: false },
      }),
      runAutoListingPlanNow: vi.fn().mockResolvedValue({ accountId: 'account-a', tickRunning: false, planStates: [] }),
    },
  };
});

vi.mock("../lib/cloudApi", () => ({
  CLOUD_AUTH_CHANGED_EVENT: "cloud-auth-changed",
  createCloudClient: vi.fn(),
  getCloudToken: vi.fn(() => null),
  cloudAccountId: vi.fn(() => ''),
}));

vi.mock("../lib/localAssistant", () => ({
  checkLocalAssistant: vi.fn().mockResolvedValue({ connected: true, compatible: true, state: "connected" }),
  checkLocalAssistantWithGracePeriod: vi.fn().mockResolvedValue({ connected: true, compatible: true, state: "connected" }),
  LOCAL_ASSISTANT_PROTOCOL_VERSION: "4",
  openLocalAssistant: vi.fn(),
}));

vi.mock("../lib/updater", () => ({
  checkDesktopUpdate: vi.fn(),
  installDesktopUpdate: vi.fn(),
}));

vi.mock("../features/auth/AuthGate", () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("../features/dashboard/DashboardPage", () => ({
  DashboardPage: ({ shops }: { shops: Array<{ name: string }> }) => <div>Dashboard {shops.map((shop) => shop.name).join(", ")}</div>,
}));
vi.mock("../features/materials/MaterialsPage", () => ({ MaterialsPage: () => <div>Materials</div> }));
vi.mock("../features/ozon/OzonPage", () => ({ OzonPage: () => <div>Ozon</div> }));
vi.mock("../features/orders/OrdersPage", () => ({ OrdersPage: () => <div>Orders</div> }));
vi.mock("../features/jobs/JobsPage", () => ({ JobsPage: () => <div>Jobs</div> }));
vi.mock("../features/cloud/CloudPage", () => ({ CloudPage: () => <div>Cloud</div> }));
vi.mock("../features/cloud/LicensePage", () => ({ LicensePage: () => <div>License</div> }));

beforeEach(() => {
  vi.mocked(checkLocalAssistant).mockResolvedValue({ connected: true, compatible: true, state: "connected" });
  vi.mocked(checkLocalAssistantWithGracePeriod).mockResolvedValue({ connected: true, compatible: true, state: "connected" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("WorkspaceModuleTabs", () => {
  it("renders asset pages as accessible tabs and keeps the current page selected", () => {
    render(<WorkspaceModuleTabs page="imagePending" onNavigate={vi.fn()} />);

    const tabs = screen.getByRole("tablist", { name: "素材页面" });
    expect(within(tabs).getAllByRole("tab")).toHaveLength(9);
    expect(within(tabs).getByRole("tab", { name: "待上传图片" }).getAttribute("aria-selected")).toBe("true");
    expect(within(tabs).getByRole("tab", { name: "GPT 图片生成" }).getAttribute("aria-selected")).toBe("false");
  });

  it("renders listing pages without the product catalog", () => {
    const onNavigate = vi.fn();
    render(<WorkspaceModuleTabs page="ozon" onNavigate={onNavigate} />);

    const tabs = screen.getByRole("tablist", { name: "上架页面" });
    const listingTabs = within(tabs).getAllByRole("tab");
    expect(listingTabs).toHaveLength(2);

    fireEvent.click(listingTabs[1]);

    expect(onNavigate).toHaveBeenCalledOnce();
    expect(onNavigate).toHaveBeenCalledWith("autoListingPlans");
  });

  it("does not render tabs for a single-page module", () => {
    render(<WorkspaceModuleTabs page="dashboard" onNavigate={vi.fn()} />);

    expect(screen.queryByRole("tablist")).toBeNull();
  });
});

describe("App workspace navigation", () => {
  it("does not start a second periodic probe while the first is pending", async () => {
    vi.useFakeTimers();
    let resolve!: (status: { connected: boolean; compatible: boolean; state: "connected" }) => void;
    const pending = new Promise<{ connected: boolean; compatible: boolean; state: "connected" }>((next) => {
      resolve = next;
    });
    vi.mocked(checkLocalAssistant).mockImplementation(() => pending);

    render(<App />);
    await Promise.resolve();
    vi.advanceTimersByTime(2_000);
    await Promise.resolve();

    expect(checkLocalAssistant).toHaveBeenCalledTimes(1);
    resolve({ connected: true, compatible: true, state: "connected" });
  });

  it.skip("waits for three failures and clears the timeout after recovery", async () => {
    vi.useFakeTimers();
    const disconnected = { connected: false, state: "disconnected" as const, error: "本地助手连接超时" };
    const connected = { connected: true, compatible: true, state: "connected" as const };
    vi.mocked(checkLocalAssistant)
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce(disconnected)
      .mockResolvedValueOnce(connected);

    render(<App />);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(screen.getByText(/连接超时/)).toBeTruthy();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(screen.queryByText(/连接超时/)).toBeNull();
  });

  it("keeps loaded workspace data after a failed assistant refresh", async () => {
    vi.mocked(api.loadAppState).mockResolvedValueOnce({
      settings: defaultSettings,
      shops: [{ id: "shop-a", name: "已加载店铺" }],
      jobs: [],
      providerSecrets: { imageApiKeyStored: false, textApiKeyStored: false },
    } as never);

    render(<App />);

    expect(await screen.findByText(/已加载店铺/)).toBeTruthy();
    vi.mocked(checkLocalAssistantWithGracePeriod).mockResolvedValue({ connected: false, state: "disconnected", error: "本地助手连接超时" });

    fireEvent.click(screen.getByTitle("刷新"));

    expect(await screen.findByText("本地助手连接超时")).toBeTruthy();
    expect(screen.getByText(/已加载店铺/)).toBeTruthy();
  });

  it('registers scheduled auto-listing without forcing execution', async () => {
    vi.mocked(getCloudToken).mockReturnValue('token-a');
    vi.mocked(cloudAccountId).mockReturnValue('account-a');

    render(<App />);

    await waitFor(() => expect(api.runAutoListingPlanNow).toHaveBeenCalledWith({
      accountId: 'account-a',
      cloudApiBaseUrl: expect.any(String),
      cloudAuthToken: 'token-a',
      force: false,
    }));
  });

  it("shows five primary modules and opens the active module pages as tabs", async () => {
    render(<App />);

    const primaryNavigation = await screen.findByRole("navigation", { name: "主模块" });
    expect(within(primaryNavigation).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "首页",
      "素材",
      "上架",
      "订单",
      "任务/设置",
    ]);

    fireEvent.click(within(primaryNavigation).getByRole("button", { name: "素材" }));

    const tabs = screen.getByRole("tablist", { name: "素材页面" });
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("转 3:4 水印");
    expect(within(tabs).getByRole("tab", { name: "转 3:4 水印" }).getAttribute("aria-selected")).toBe("true");
  });
});
