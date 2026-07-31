import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./lib/api";

const assistantStatus = vi.hoisted(() => ({
  value: {
    connected: true,
    compatible: true as boolean | undefined,
    state: "connected" as "checking" | "connected" | "disconnected" | "incompatible",
    error: undefined as string | undefined,
  },
}));

vi.mock("./lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/api")>();
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
      runAutoListingPlanNow: vi.fn().mockResolvedValue({ accountId: "account-a", tickRunning: false, planStates: [] }),
    },
  };
});

vi.mock("./lib/cloudApi", () => ({
  CLOUD_AUTH_CHANGED_EVENT: "cloud-auth-changed",
  cloudAccountId: vi.fn(() => ""),
  createCloudClient: vi.fn(() => ({ getAiSettings: vi.fn() })),
  getCloudToken: vi.fn(() => null),
}));

vi.mock("./lib/localAssistant", () => ({
  checkLocalAssistant: vi.fn().mockImplementation(() => Promise.resolve(assistantStatus.value)),
  checkLocalAssistantWithGracePeriod: vi.fn().mockImplementation(() => Promise.resolve(assistantStatus.value)),
  LOCAL_ASSISTANT_PROTOCOL_VERSION: "4",
  openLocalAssistant: vi.fn(),
}));

vi.mock("./lib/updater", () => ({
  checkDesktopUpdate: vi.fn(),
  installDesktopUpdate: vi.fn(),
}));

vi.mock("./features/auth/AuthGate", () => ({
  AuthGate: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("./features/dashboard/DashboardPage", () => ({ DashboardPage: () => <div>Dashboard</div> }));
vi.mock("./features/materials/MaterialsPage", () => ({ MaterialsPage: () => <div>Materials</div> }));
vi.mock("./features/ozon/OzonPage", () => ({ OzonPage: () => <div>Ozon</div> }));
vi.mock("./features/orders/OrdersPage", () => ({ OrdersPage: () => <div>Orders</div> }));
vi.mock("./features/jobs/JobsPage", () => ({ JobsPage: () => <div>Jobs</div> }));
vi.mock("./features/cloud/CloudPage", () => ({ CloudPage: () => <div>Cloud</div> }));
vi.mock("./features/cloud/LicensePage", () => ({ LicensePage: () => <div>License</div> }));

afterEach(() => {
  assistantStatus.value = { connected: true, compatible: true, state: "connected", error: undefined };
  document.body.innerHTML = "";
  vi.clearAllMocks();
  vi.resetModules();
});

describe("web entry", () => {
  it("mounts the full workspace navigation", async () => {
    document.body.innerHTML = '<div id="root"></div>';

    await import("./web-main");

    const primaryNavigation = await screen.findByRole("navigation", { name: "主模块" });
    await waitFor(() => expect(api.loadAppState).toHaveBeenCalled());
    expect(within(primaryNavigation).getAllByRole("button").map((button) => button.textContent?.trim())).toEqual([
      "首页",
      "素材",
      "上架",
      "订单",
      "任务/设置",
    ]);
  });

  it("keeps the workspace navigation visible while the local assistant is unavailable", async () => {
    assistantStatus.value = { connected: false, compatible: undefined, state: "disconnected", error: "本地助手未启动" };
    document.body.innerHTML = '<div id="root"></div>';

    await import("./web-main");

    const primaryNavigation = await screen.findByRole("navigation", { name: "主模块" });
    expect(within(primaryNavigation).getByRole("button", { name: "首页" })).toBeTruthy();
    expect(screen.queryByText("请先打开客户端助手")).toBeNull();
  });
});
