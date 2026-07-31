import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings, Shop } from "@shared/types";
import { api } from "../../lib/api";
import { createCloudClient } from "../../lib/cloudApi";
import { DashboardPage } from "./DashboardPage";

vi.mock("../../lib/api", () => ({
  api: {
    listOrderPostings: vi.fn().mockResolvedValue([]),
    getShopUploadQuota: vi.fn(),
    openPath: vi.fn(),
  },
}));

const cloudClient = {
  listDailyListingStats: vi.fn(),
  getListingPreferences: vi.fn(),
};

vi.mock("../../lib/cloudApi", () => ({
  createCloudClient: vi.fn(() => cloudClient),
}));

const quotaFilterKey = "ozon-sjsq:dashboard-quota-filter:v1";

const settings: AppSettings = {
  cloudApiBaseUrl: "https://api.example.test",
  defaultSourceRoot: "",
  defaultOutputRoot: "",
  baiduCookie: "",
  watermarkPath: "",
  contentRoot: "",
  uploadExcelPath: "",
  uploadMaxItems: 100,
  listedUpdateMaxWorkers: 2,
  imageProvider: "pixel",
  textProvider: "xiaoqian",
  imageBaseUrl: "",
  textBaseUrl: "",
  imageModel: "",
  textModel: "",
  maxWorkers: 3,
  maxFolders: 0,
  exportExcel: true,
  convertOriginals: true,
  generateCopy: false,
  quality: "high",
  sceneSourceRoot: "",
  sceneOutputRoot: "",
  sceneMockupRoot: "",
  sceneSingleImage: "",
  sceneAspectRatio: "1:1",
  sceneCount: 8,
  sceneMaxWorkers: 2,
  sceneMaxFolders: 0,
  sceneSizeLabel: "",
  scenePromptTemplate: "",
  imagePromptTemplate: "",
  titlePromptTemplate: "",
  descriptionPromptTemplate: "",
  selectedTemplateName: "",
  materialPortraitSourceRoot: "",
  materialPortraitOutputRoot: "",
  materialPortraitMaxItems: 0,
  materialTitleSourceRoot: "",
  materialTitleOutputRoot: "",
  materialTitleMaxItems: 0,
  materialRenameSourceRoot: "",
  materialRenameOutputRoot: "",
  materialRenamePrefix: "",
};

function shop(id: string, name: string): Shop {
  return {
    id,
    name,
    clientId: `client-${id}`,
    apiKeyStored: true,
    ossAccessKeyStored: true,
    ozonSellerCookieStored: false,
    enabled: true,
    createdAt: "2026-07-09T00:00:00.000Z",
    updatedAt: "2026-07-09T00:00:00.000Z",
  };
}

function quotaSection() {
  return screen.getByRole("heading", { name: "店铺健康矩阵" }).closest("section")!;
}

function renderDashboard() {
  return render(
    <DashboardPage
      shops={[]}
      jobs={[]}
      settings={settings}
      providerSecrets={{ imageApiKeyStored: false, textApiKeyStored: false }}
      onNavigate={vi.fn()}
      onOpenJobLogs={vi.fn()}
    />,
  );
}

describe("DashboardPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.mocked(api.listOrderPostings).mockResolvedValue([]);
    vi.mocked(api.getShopUploadQuota).mockResolvedValue({
      dailyCreateLimit: 100,
      dailyCreateUsage: 0,
      dailyCreateRemaining: 100,
      dailyUpdateLimit: 5000,
      dailyUpdateUsage: 0,
      dailyUpdateRemaining: 5000,
      totalLimit: 1000,
      totalUsage: 0,
      totalRemaining: 1000,
      fetchedAt: "2026-07-30T00:00:00.000Z",
    });
    vi.mocked(createCloudClient).mockClear();
    cloudClient.listDailyListingStats.mockResolvedValue({
      ok: true,
      stats: [
        {
          externalShopId: "shop-full",
          shopName: "满额店",
          date: "2026-07-09",
          listedCount: 0,
          reservedCount: 300,
          pendingCount: 300,
        },
        {
          externalShopId: "shop-free",
          shopName: "可用店",
          date: "2026-07-09",
          listedCount: 0,
          reservedCount: 0,
          pendingCount: 0,
        },
      ],
    });
    cloudClient.getListingPreferences.mockResolvedValue({
      ok: true,
      preferences: {
        shopListingConfigs: [
          { externalShopId: "shop-full", dailyListingLimit: 300 },
          { externalShopId: "shop-free", dailyListingLimit: 300 },
        ],
      },
      updatedAt: "2026-07-09T00:00:00.000Z",
    });
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
  });

  it("exposes the dashboard content as a named region", () => {
    renderDashboard();

    expect(screen.getByRole("region", { name: "首页数据大屏" })).toBeTruthy();
  });

  it("groups the headline figures as a named metric list", () => {
    renderDashboard();

    const metrics = screen.getByRole("list", { name: "今日运营指标" });
    expect(within(metrics).getAllByRole("listitem")).toHaveLength(4);
  });

  it("combines store order and quota data into one paged dashboard matrix", async () => {
    render(
      <DashboardPage
        shops={[shop("shop-main", "主店1"), shop("shop-follow", "跟卖1")]}
        jobs={[]}
        settings={settings}
        providerSecrets={{ imageApiKeyStored: false, textApiKeyStored: false }}
        onNavigate={vi.fn()}
        onOpenJobLogs={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.getShopUploadQuota).toHaveBeenCalledTimes(2));

    const cockpit = screen.getByRole("region", { name: "首页数据大屏" });
    const matrix = within(cockpit).getByRole("list", { name: "店铺健康矩阵" });
    expect(within(matrix).getByText("主店1")).toBeTruthy();
    expect(within(matrix).getByText("跟卖1")).toBeTruthy();
    expect(within(cockpit).queryByRole("heading", { name: "店铺订单汇总" })).toBeNull();
    expect(within(cockpit).queryByRole("heading", { name: "今日上架额度" })).toBeNull();
    expect(within(cockpit).queryByText("合并订单、销售额、上架额度和店铺状态；店铺多时只在表格内部滚动。")).toBeNull();
    expect(within(cockpit).queryByRole("button", { name: "查看订单明细" })).toBeNull();
  });

  it("paginates stores instead of making the dashboard longer", async () => {
    const shops = Array.from({ length: 10 }, (_, index) => shop(`shop-${index + 1}`, `店铺${index + 1}`));

    render(
      <DashboardPage
        shops={shops}
        jobs={[]}
        settings={settings}
        providerSecrets={{ imageApiKeyStored: false, textApiKeyStored: false }}
        onNavigate={vi.fn()}
        onOpenJobLogs={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.getShopUploadQuota).toHaveBeenCalledTimes(10));

    const cockpit = screen.getByRole("region", { name: "首页数据大屏" });
    expect(within(cockpit).getByText("第 1 / 2 屏 · 1-8 / 10 家")).toBeTruthy();
    expect(within(cockpit).getByText("店铺8")).toBeTruthy();
    expect(within(cockpit).queryByText("店铺9")).toBeNull();

    fireEvent.click(within(cockpit).getByRole("button", { name: "下一屏店铺" }));

    expect(within(cockpit).getByText("第 2 / 2 屏 · 9-10 / 10 家")).toBeTruthy();
    expect(within(cockpit).getByText("店铺9")).toBeTruthy();
    expect(within(cockpit).queryByText("店铺1")).toBeNull();
  });

  it("restores and persists the listing quota filter", async () => {
    window.localStorage.setItem(quotaFilterKey, "full");
    vi.mocked(api.getShopUploadQuota).mockImplementation(async (shopId) => (
      shopId === "shop-full"
        ? {
          dailyCreateLimit: 300,
          dailyCreateUsage: 300,
          dailyCreateRemaining: 0,
          dailyUpdateLimit: 5000,
          dailyUpdateUsage: 0,
          dailyUpdateRemaining: 5000,
          totalLimit: 1000,
          totalUsage: 300,
          totalRemaining: 700,
          fetchedAt: "2026-07-30T00:00:00.000Z",
        }
        : {
          dailyCreateLimit: 300,
          dailyCreateUsage: 0,
          dailyCreateRemaining: 300,
          dailyUpdateLimit: 5000,
          dailyUpdateUsage: 0,
          dailyUpdateRemaining: 5000,
          totalLimit: 1000,
          totalUsage: 0,
          totalRemaining: 1000,
          fetchedAt: "2026-07-30T00:00:00.000Z",
        }
    ));

    render(
      <DashboardPage
        shops={[shop("shop-full", "满额店"), shop("shop-free", "可用店")]}
        jobs={[]}
        settings={settings}
        providerSecrets={{ imageApiKeyStored: false, textApiKeyStored: false }}
        onNavigate={vi.fn()}
        onOpenJobLogs={vi.fn()}
      />,
    );

    await waitFor(() => expect(cloudClient.listDailyListingStats).toHaveBeenCalled());

    const section = quotaSection();
    expect(within(section).getByText("满额店")).toBeTruthy();
    expect(within(section).queryByText("可用店")).toBeNull();

    fireEvent.click(within(section).getByRole("button", { name: "处理中" }));
    expect(window.localStorage.getItem(quotaFilterKey)).toBe("processing");
  });

  it("shows live Ozon create quota and explains a total quota block", async () => {
    cloudClient.listDailyListingStats.mockResolvedValue({
      ok: true,
      stats: [
        {
          externalShopId: "shop-main",
          shopName: "主店1",
          date: "2026-07-30",
          listedCount: 83,
          reservedCount: 83,
          pendingCount: 0,
        },
        {
          externalShopId: "shop-follow",
          shopName: "跟卖1",
          date: "2026-07-30",
          listedCount: 0,
          reservedCount: 0,
          pendingCount: 0,
        },
      ],
    });
    cloudClient.getListingPreferences.mockResolvedValue({
      ok: true,
      preferences: {
        shopListingConfigs: [
          { externalShopId: "shop-main", dailyListingLimit: 300 },
          { externalShopId: "shop-follow", dailyListingLimit: 300 },
        ],
      },
      updatedAt: "2026-07-30T00:00:00.000Z",
    });
    vi.mocked(api.getShopUploadQuota).mockImplementation(async (shopId) => (
      shopId === "shop-follow"
        ? {
          dailyCreateLimit: 100,
          dailyCreateUsage: 0,
          dailyCreateRemaining: 100,
          dailyUpdateLimit: 5000,
          dailyUpdateUsage: 0,
          dailyUpdateRemaining: 5000,
          totalLimit: 1000,
          totalUsage: 1125,
          totalRemaining: 0,
          fetchedAt: "2026-07-30T05:36:47.000+08:00",
        }
        : {
          dailyCreateLimit: 100,
          dailyCreateUsage: 96,
          dailyCreateRemaining: 4,
          dailyUpdateLimit: 5000,
          dailyUpdateUsage: 0,
          dailyUpdateRemaining: 5000,
          totalLimit: 3000,
          totalUsage: 2470,
          totalRemaining: 530,
          fetchedAt: "2026-07-30T05:36:47.000+08:00",
        }
    ));

    render(
      <DashboardPage
        shops={[shop("shop-main", "主店1"), shop("shop-follow", "跟卖1")]}
        jobs={[]}
        settings={settings}
        providerSecrets={{ imageApiKeyStored: false, textApiKeyStored: false }}
        onNavigate={vi.fn()}
        onOpenJobLogs={vi.fn()}
      />,
    );

    await waitFor(() => expect(api.getShopUploadQuota).toHaveBeenCalledTimes(2));

    const section = quotaSection();
    const mainCard = within(section).getByText("主店1").closest("article")!;
    expect(within(mainCard).getByText("4")).toBeTruthy();
    expect(within(mainCard).getByText("530")).toBeTruthy();

    const blockedCard = within(section).getByText("跟卖1").closest("article")!;
    expect(within(blockedCard).getByText("总额度已满")).toBeTruthy();
    expect(within(blockedCard).queryByText("可用")).toBeNull();
  });
});
