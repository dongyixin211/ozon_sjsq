import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudAsset, CloudListingBatch, CloudMockupAsset, CloudMockupTemplate, CloudProductImageRule, JobSummary } from "@shared/types";
import type { CloudClient, CloudListingPreferences, CloudProductTemplate } from "../../lib/cloudApi";
import { api } from "../../lib/api";
import { GalleryManager } from "./GalleryManager";

vi.mock("../../lib/api", () => ({
  api: {
    loadAppState: vi.fn(),
    listTemplates: vi.fn().mockResolvedValue([]),
    listWarehouses: vi.fn().mockResolvedValue([]),
    listActions: vi.fn().mockResolvedValue({ result: [] }),
    listJobs: vi.fn().mockResolvedValue([]),
    listJobLogs: vi.fn().mockResolvedValue([]),
    cancelJob: vi.fn().mockResolvedValue(true),
    startListingImageRepair: vi.fn(),
    startAutoListing: vi.fn().mockResolvedValue({
      id: "job-auto-listing",
      kind: "auto_listing",
      title: "云图库自动上架",
      status: "running",
      progress: 5,
      inputPath: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-06-14T00:00:00.000Z",
      updatedAt: "2026-06-14T00:00:00.000Z",
    }),
  },
}));

const mockupTemplate: CloudMockupTemplate = {
  id: "fangjin",
  name: "方巾样机",
  sceneCount: 6,
  outputWidth: 800,
  outputHeight: 1067,
};

const otherMockupTemplate: CloudMockupTemplate = {
  id: "toujin",
  name: "头巾样机",
  sceneCount: 3,
  outputWidth: 900,
  outputHeight: 1200,
};

const productImageRule: CloudProductImageRule = {
  id: "00000000-0000-4000-8000-000000000101",
  productType: "方巾 / 头巾 / 丝巾",
  aspectRatio: "1:1",
  ratioWidth: 1,
  ratioHeight: 1,
  enabled: true,
  createdAt: "2026-06-14T00:00:00.000Z",
  updatedAt: "2026-06-14T00:00:00.000Z",
};

const baseAsset: CloudAsset = {
  id: "asset-1",
  sku: "DYXSFD202606140001",
  sha256: "source-sha",
  ratio: 1,
  ratioFamily: "square",
  productImageRuleId: productImageRule.id,
  productType: productImageRule.productType,
  aspectRatio: productImageRule.aspectRatio,
  width: 1200,
  height: 1200,
  publicUrl: "https://example.test/source.png",
  thumbUrl: "https://example.test/source-thumb.png",
  contentType: "image/png",
  sizeBytes: 1024,
  sourceFilename: "DYXSFD202606140001.png",
  createdAt: "2026-06-14T00:00:00.000Z",
};

function makeMockupAsset(sceneIndex: number, template = mockupTemplate): CloudMockupAsset {
  return {
    ...baseAsset,
    id: `${template.id}-mockup-${sceneIndex}`,
    sku: `${baseAsset.sku}-${template.id}-${String(sceneIndex).padStart(2, "0")}`,
    sha256: `${template.id}-mockup-sha-${sceneIndex}`,
    publicUrl: `https://example.test/${template.id}-mockup-${sceneIndex}.jpg`,
    thumbUrl: `https://example.test/${template.id}-mockup-${sceneIndex}-thumb.jpg`,
    width: template.outputWidth,
    height: template.outputHeight,
    sourceFilename: `${baseAsset.sku}-${template.id}-${String(sceneIndex).padStart(2, "0")}.jpg`,
    templateId: template.id,
    templateName: template.name,
    sceneIndex,
  };
}

function uuidFor(prefix: string, index: number) {
  return `${prefix}-${String(index).padStart(12, "0")}`;
}

function makeUuidMockupAsset(source: CloudAsset, sceneIndex: number, template = mockupTemplate): CloudMockupAsset {
  return {
    ...makeMockupAsset(sceneIndex, template),
    id: uuidFor("33333333-3333-4333-8333", sceneIndex),
    sku: `${source.sku}-${template.id}-${String(sceneIndex).padStart(2, "0")}`,
    sourceFilename: `${source.sku}-${template.id}-${String(sceneIndex).padStart(2, "0")}.jpg`,
  };
}

function makeLocalShop(shopId: string, name = "跟卖测试店") {
  return {
    id: shopId,
    name,
    clientId: "5127411",
    apiKeyStored: true,
    ossAccessKeyStored: true,
    ozonSellerCookieStored: false,
    enabled: true,
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
  };
}

function mockListingSetup(client: CloudClient, shopId: string, localTemplateId: string, templateName = "头巾模板") {
  vi.mocked(api.listTemplates).mockResolvedValue([{
    id: localTemplateId,
    kind: "product_import",
    name: templateName,
    payload: { offer_id: "TEMPLATE", name: "模板商品", images: [] },
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
  }]);
  vi.mocked(client.getListingPreferences).mockResolvedValue({
    ok: true,
    updatedAt: "2026-07-05T00:00:00.000Z",
    preferences: {
      ratioFamily: "square",
      productImageRuleId: productImageRule.id,
      selectedShopId: shopId,
      selectedMockupTemplate: mockupTemplate.id,
      shopListingConfigs: [{
        externalShopId: shopId,
        productTemplateId: "cloud-template-headscarf",
        productTemplateName: templateName,
        newTemplateName: templateName,
        localTemplateId,
        autoGenerateBarcode: true,
        autoUpdateStock: false,
        autoAddToAction: false,
      }],
    },
  });
}

function makeListingBatch(options: {
  id?: string;
  assets: CloudAsset[];
  imageAssetsBySourceId: Record<string, CloudMockupAsset[]>;
  shopId: string;
  shopName?: string;
  templateName?: string;
}): CloudListingBatch {
  const batchId = options.id ?? "11111111-1111-4111-8111-111111111111";
  const shopName = options.shopName ?? "跟卖测试店";
  const templateName = options.templateName ?? "头巾模板";
  return {
    id: batchId,
    status: "prepared",
    ratioFamily: "square",
    productImageRuleId: productImageRule.id,
    productType: productImageRule.productType,
    aspectRatio: productImageRule.aspectRatio,
    mockupTemplateId: mockupTemplate.id,
    mockupTemplateName: mockupTemplate.name,
    titlePromptTemplateId: null,
    titlePromptTemplateName: null,
    titlePrompt: null,
    imageSets: options.assets.map((asset) => {
      const images = options.imageAssetsBySourceId[asset.id] ?? [];
      return {
        externalShopId: options.shopId,
        shopName,
        productTemplateName: templateName,
        sourceAssetId: asset.id,
        sourceSku: asset.sku,
        sourceUrl: asset.publicUrl,
        sourceThumbUrl: asset.thumbUrl,
        imageAssetIds: images.map((image) => image.id),
        imageUrls: images.map((image) => image.publicUrl),
        configSnapshot: {
          externalShopId: options.shopId,
          localShopId: options.shopId,
          localTemplateId: "local-template-headscarf",
          productTemplateId: "cloud-template-headscarf",
          productTemplateName: templateName,
          templateProduct: { offer_id: "TEMPLATE", name: "模板商品", images: [] },
          autoGenerateBarcode: true,
          autoUpdateStock: false,
          autoAddToAction: false,
          postListingDelayMinutes: 3,
          actionDelayMinutes: 0,
          actionRetryCount: 72,
          actionRetryIntervalMinutes: 10,
        },
        title: asset.generatedTitle ?? `标题 ${asset.id}`,
      };
    }),
    shopTargets: [{
      externalShopId: options.shopId,
      shopName,
      productTemplateId: "cloud-template-headscarf",
      productTemplateName: templateName,
      status: "prepared",
      uploadedAt: null,
      error: null,
      configSnapshot: {
        externalShopId: options.shopId,
        localShopId: options.shopId,
        localTemplateId: "local-template-headscarf",
        productTemplateId: "cloud-template-headscarf",
        productTemplateName: templateName,
        templateProduct: { offer_id: "TEMPLATE", name: "模板商品", images: [] },
        autoGenerateBarcode: true,
        autoUpdateStock: false,
        autoAddToAction: false,
        postListingDelayMinutes: 3,
        actionDelayMinutes: 0,
        actionRetryCount: 72,
        actionRetryIntervalMinutes: 10,
      },
    }],
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
  };
}

function createClient(asset: CloudAsset | CloudAsset[], templates: CloudMockupTemplate[] = [mockupTemplate]): CloudClient {
  const assets = Array.isArray(asset) ? asset : [asset];
  return {
    health: vi.fn(),
    me: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    redeemLicense: vi.fn(),
    getAiSettings: vi.fn(),
    listShops: vi.fn().mockResolvedValue({ ok: true, shops: [] }),
    upsertShop: vi.fn(),
    syncShop: vi.fn(),
    listAssets: vi.fn().mockResolvedValue({ ok: true, assets, total: assets.length, limit: 40, offset: 0 }),
    listFeaturedAssets: vi.fn(),
    uploadAsset: vi.fn(),
    uploadAssets: vi.fn(),
    listProductImageRules: vi.fn().mockResolvedValue({ ok: true, rules: [productImageRule] }),
    downloadAssetOriginal: vi.fn().mockRejectedValue(new Error("download unavailable in test")),
    listMockupTemplates: vi.fn().mockResolvedValue({ ok: true, templates }),
    getMockupTemplatePackage: vi.fn().mockRejectedValue(new Error("local renderer unavailable in test")),
    uploadLocalMockupResult: vi.fn(),
    renderMockup: vi.fn(),
    renderFangjinMockup: vi.fn(),
    markAssetUsed: vi.fn(),
    deleteAsset: vi.fn(),
    listTitlePromptTemplates: vi.fn().mockResolvedValue({ ok: true, templates: [] }),
    saveTitlePromptTemplate: vi.fn(),
    listProductTemplates: vi.fn().mockResolvedValue({ ok: true, templates: [] }),
    saveProductTemplate: vi.fn(),
    getListingPreferences: vi.fn().mockResolvedValue({ ok: true, preferences: {}, updatedAt: null }),
    saveListingPreferences: vi.fn().mockResolvedValue({ ok: true, preferences: {}, updatedAt: "2026-06-14T00:00:00.000Z" }),
    generateListingTitle: vi.fn(),
    createListingBatch: vi.fn(),
    listListingBatches: vi.fn().mockResolvedValue({ ok: true, batches: [] }),
    getListingBatch: vi.fn(),
    markListingBatchUploaded: vi.fn(),
    listListingReconciliation: vi.fn().mockResolvedValue({
      ok: true,
      summary: {
        dateFrom: "2026-07-28",
        dateTo: "2026-07-28",
        total: 0,
        completedCount: 0,
        failedCount: 0,
        processingCount: 0,
        mockupRunningCount: 0,
        titleRunningCount: 0,
        listingRunningCount: 0,
        shops: [],
        batches: [],
      },
    }),
    updateListingRepairImages: vi.fn(),
    listDailyListingStats: vi.fn().mockResolvedValue({ ok: true, stats: [] }),
    syncSalesSignals: vi.fn(),
    syncTaskHistory: vi.fn(),
  } as unknown as CloudClient;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitForDelay(milliseconds: number) {
  await new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function findListingRow(container: HTMLElement, externalShopId: string) {
  return Array.from(container.querySelectorAll<HTMLElement>(".listing-shop-row"))
    .find((row) => row.querySelector("select")?.value === externalShopId);
}
function emptyAppSnapshot(): Awaited<ReturnType<typeof api.loadAppState>> {
  return {
    settings: {},
    shops: [],
    jobs: [],
    providerSecrets: { imageApiKeyStored: false, textApiKeyStored: false },
  } as unknown as Awaited<ReturnType<typeof api.loadAppState>>;
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  window.localStorage.clear();
  vi.mocked(api.loadAppState).mockResolvedValue(emptyAppSnapshot());
  vi.mocked(api.listTemplates).mockResolvedValue([]);
  vi.mocked(api.listWarehouses).mockResolvedValue([]);
  vi.mocked(api.listActions).mockResolvedValue({ result: [] });
  vi.mocked(api.listJobs).mockResolvedValue([]);
  vi.mocked(api.listJobLogs).mockResolvedValue([]);
  vi.mocked(api.cancelJob).mockResolvedValue(true);
  vi.mocked(api.startListingImageRepair).mockResolvedValue({
    id: "job-listing-image-repair",
    kind: "listing_image_repair",
    title: "更新 Ozon 商品图片",
    status: "running",
    progress: 5,
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
  });
  vi.mocked(api.startAutoListing).mockResolvedValue({
    id: "job-auto-listing",
    kind: "auto_listing",
    title: "云图库自动上架",
    status: "running",
    progress: 5,
    inputPath: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-06-14T00:00:00.000Z",
    updatedAt: "2026-06-14T00:00:00.000Z",
  });
});

describe("GalleryManager", () => {
  it("ignores an older asset response after switching gallery modes", async () => {
    const pendingRequest = createDeferred<{ ok: boolean; assets: CloudAsset[]; total: number; limit: number; offset: number }>();
    const uploadedRequest = createDeferred<{ ok: boolean; assets: CloudAsset[]; total: number; limit: number; offset: number }>();
    const pendingAsset = { ...baseAsset, id: "pending-stale", sku: "PENDING-STALE" };
    const uploadedAsset = { ...baseAsset, id: "uploaded-latest", sku: "UPLOADED-LATEST" };
    const client = createClient([]);
    vi.mocked(client.listAssets).mockImplementation((query) => (
      query.listingStatus === "pending" ? pendingRequest.promise : uploadedRequest.promise
    ));

    const view = render(<GalleryManager mode="pending" client={client} shops={[]} onMessage={vi.fn()} />);

    await waitFor(() => expect(client.listAssets).toHaveBeenCalledWith(expect.objectContaining({ listingStatus: "pending" })));
    view.rerender(<GalleryManager mode="uploaded" client={client} shops={[]} onMessage={vi.fn()} />);
    await waitFor(() => expect(client.listAssets).toHaveBeenCalledWith(expect.objectContaining({ listingStatus: "uploaded" })));

    await act(async () => {
      uploadedRequest.resolve({ ok: true, assets: [uploadedAsset], total: 1, limit: 10, offset: 0 });
      await uploadedRequest.promise;
    });
    expect(screen.getByText("UPLOADED-LATEST")).toBeTruthy();

    await act(async () => {
      pendingRequest.resolve({ ok: true, assets: [pendingAsset], total: 1, limit: 10, offset: 0 });
      await pendingRequest.promise;
    });
    expect(screen.queryByText("PENDING-STALE")).toBeNull();
    expect(screen.getByText("UPLOADED-LATEST")).toBeTruthy();
  });

  it("keeps orphaned local processing cache in the pending list", async () => {
    window.localStorage.setItem(
      "ozon-sjsq:gallery-local-processing:v1:default",
      JSON.stringify([{ asset: baseAsset, savedAt: Date.now() }]),
    );
    const client = createClient(baseAsset);

    render(<GalleryManager mode="pending" client={client} shops={[]} onMessage={vi.fn()} />);

    expect(await screen.findByText(baseAsset.sku)).toBeTruthy();
    expect(client.listAssets).toHaveBeenCalledWith(expect.objectContaining({
      excludeAssetIds: [],
      listingStatus: "pending",
    }));
    expect(api.startAutoListing).not.toHaveBeenCalled();
  });

  it("shows mockup thumbnails behind the source image and opens the detail dialog", async () => {
    const assetWithMockups: CloudAsset = {
      ...baseAsset,
      mockupResults: Array.from({ length: 6 }, (_, index) => makeMockupAsset(index + 1)),
    };

    render(<GalleryManager mode="pending" client={createClient(assetWithMockups)} shops={[]} onMessage={vi.fn()} />);

    expect(await screen.findByText("DYXSFD202606140001")).toBeTruthy();
    fireEvent.click(screen.getByTitle("图片展示"));
    expect(screen.getByText("方巾样机 6 张")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "查看 DYXSFD202606140001 的方巾样机套图详情" }));

    await waitFor(() => expect(screen.getByRole("dialog", { name: "DYXSFD202606140001 方巾样机套图详情" })).toBeTruthy());
    expect(screen.getByText("当前样机共 6 张效果图")).toBeTruthy();
    expect(screen.getByText("方巾样机 · 场景 6")).toBeTruthy();
  });

  it("only shows mockup results for the currently selected template", async () => {
    const assetWithMixedMockups: CloudAsset = {
      ...baseAsset,
      mockupResults: [
        ...Array.from({ length: 6 }, (_, index) => makeMockupAsset(index + 1, mockupTemplate)),
        ...Array.from({ length: 3 }, (_, index) => makeMockupAsset(index + 1, otherMockupTemplate)),
      ],
    };

    render(<GalleryManager mode="pending" client={createClient(assetWithMixedMockups, [mockupTemplate, otherMockupTemplate])} shops={[]} onMessage={vi.fn()} />);

    fireEvent.click(screen.getByTitle("图片展示"));
    expect(await screen.findByText("方巾样机 6 张")).toBeTruthy();
    expect(screen.queryByText("头巾样机 3 张")).toBeNull();

    fireEvent.change(screen.getByLabelText("当前套图样机"), { target: { value: "toujin" } });

    expect(await screen.findByText("头巾样机 3 张")).toBeTruthy();
    expect(screen.queryByText("方巾样机 6 张")).toBeNull();
  });

  it("keeps the pending list compact without mockup and title result columns", async () => {
    render(<GalleryManager mode="pending" client={createClient(baseAsset)} shops={[]} onMessage={vi.fn()} />);

    expect(await screen.findByText("DYXSFD202606140001")).toBeTruthy();
    expect(screen.queryByText("套图结果")).toBeNull();
    expect(screen.getByText("1:1")).toBeTruthy();
  });

  it("automatically renders missing mockups when one-click listing starts", async () => {
    const shopId = "shop-auto-mockup";
    const localTemplateId = "local-template-headscarf";
    const sourceAsset: CloudAsset = {
      ...baseAsset,
      id: "22222222-2222-4222-8222-222222222222",
      generatedTitle: "自动套图测试标题",
    };
    const mockupAssets = Array.from({ length: 6 }, (_, index) => makeUuidMockupAsset(sourceAsset, index + 1));
    const client = createClient(sourceAsset);
    const onMessage = vi.fn();
    const batch = makeListingBatch({
      assets: [sourceAsset],
      imageAssetsBySourceId: { [sourceAsset.id]: mockupAssets },
      shopId,
    });
    mockListingSetup(client, shopId, localTemplateId);
    vi.mocked(client.renderMockup).mockResolvedValue({
      ok: true,
      sourceAsset: {
        id: sourceAsset.id,
        sku: sourceAsset.sku,
        sourceFilename: sourceAsset.sourceFilename,
      },
      template: mockupTemplate,
      generated: 6,
      assets: mockupAssets,
    });
    vi.mocked(client.createListingBatch).mockResolvedValue({ ok: true, batch });
    vi.mocked(client.getListingBatch).mockResolvedValue({ ok: true, batch });

    render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: shopId, externalShopId: shopId, name: "跟卖测试店" }]}
        localShops={[makeLocalShop(shopId)]}
        onMessage={onMessage}
      />,
    );

    expect(await screen.findByText(sourceAsset.sku)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`选择 ${sourceAsset.sku}`));
    const oneClickButton = screen.getByRole("button", { name: /选中图片一键上架/ }) as HTMLButtonElement;
    await waitFor(() => expect(oneClickButton.disabled).toBe(false));
    fireEvent.click(oneClickButton);

    await waitFor(() => expect(client.renderMockup).toHaveBeenCalledWith(mockupTemplate.id, sourceAsset.id));
    await waitFor(() => expect(client.createListingBatch).toHaveBeenCalledWith(expect.objectContaining({
      productImageRuleId: productImageRule.id,
      assets: [expect.objectContaining({
        sourceAssetId: sourceAsset.id,
        imageAssetIds: mockupAssets.map((asset) => asset.id),
        title: "自动套图测试标题",
      })],
    })));
  });

  it("falls back to cloud rendering during one-click listing when local mockup rendering is unavailable", async () => {
    const shopId = "shop-auto-fallback";
    const localTemplateId = "local-template-headscarf";
    const sourceAsset: CloudAsset = {
      ...baseAsset,
      id: "22222222-2222-4222-8222-222222222223",
      generatedTitle: "云端兜底套图标题",
    };
    const mockupAssets = Array.from({ length: 6 }, (_, index) => makeUuidMockupAsset(sourceAsset, index + 1));
    const client = createClient(sourceAsset);
    const onMessage = vi.fn();
    const batch = makeListingBatch({
      assets: [sourceAsset],
      imageAssetsBySourceId: { [sourceAsset.id]: mockupAssets },
      shopId,
    });
    mockListingSetup(client, shopId, localTemplateId);
    vi.mocked(client.getMockupTemplatePackage).mockRejectedValue(new Error("本机渲染不可用"));
    vi.mocked(client.renderMockup).mockResolvedValue({
      ok: true,
      sourceAsset: {
        id: sourceAsset.id,
        sku: sourceAsset.sku,
        sourceFilename: sourceAsset.sourceFilename,
      },
      template: mockupTemplate,
      generated: 6,
      assets: mockupAssets,
    });
    vi.mocked(client.createListingBatch).mockResolvedValue({ ok: true, batch });
    vi.mocked(client.getListingBatch).mockResolvedValue({ ok: true, batch });

    render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: shopId, externalShopId: shopId, name: "跟卖测试店" }]}
        localShops={[makeLocalShop(shopId)]}
        onMessage={onMessage}
      />,
    );

    expect(await screen.findByText(sourceAsset.sku)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`选择 ${sourceAsset.sku}`));
    const oneClickButton = screen.getByRole("button", { name: /选中图片一键上架/ }) as HTMLButtonElement;
    await waitFor(() => expect(oneClickButton.disabled).toBe(false));
    fireEvent.click(oneClickButton);

    await waitFor(() => expect(client.getMockupTemplatePackage).toHaveBeenCalledWith(mockupTemplate.id));
    await waitFor(() => expect(client.renderMockup).toHaveBeenCalledWith(mockupTemplate.id, sourceAsset.id));
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("本机套图失败，已自动切换云端生成"));
  });

  it("passes the selected mockup status filter to the gallery query", async () => {
    const client = createClient(baseAsset);

    render(<GalleryManager mode="pending" client={client} shops={[]} onMessage={vi.fn()} />);

    await waitFor(() => expect(client.listAssets).toHaveBeenCalled());

    fireEvent.change(screen.getByLabelText("套图状态"), { target: { value: "not_rendered" } });
    fireEvent.click(screen.getByRole("button", { name: /查询图片/ }));

    await waitFor(() => expect(client.listAssets).toHaveBeenLastCalledWith(expect.objectContaining({
      mockupTemplateId: mockupTemplate.id,
      mockupStatus: "not_rendered",
    })));
  });

  it("restores listing preferences for shop, ratio and mockup template", async () => {
    const client = createClient(baseAsset, [mockupTemplate, otherMockupTemplate]);
    vi.mocked(client.getListingPreferences).mockResolvedValue({
      ok: true,
      updatedAt: "2026-06-14T00:00:00.000Z",
      preferences: {
        ratioFamily: "square",
        selectedShopId: "shop-1",
        selectedMockupTemplate: otherMockupTemplate.id,
        titlePromptName: "上次标题模板",
        titlePrompt: "上次提示词 {sku}",
        shopListingConfigs: [{
          externalShopId: "shop-1",
          productTemplateName: "方巾正式模板",
          newTemplateName: "方巾正式模板",
          localTemplateId: "local-template-1",
          autoGenerateBarcode: true,
          autoUpdateStock: true,
          autoStock: 15,
        }],
      },
    });

    render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: "shop-1", externalShopId: "shop-1", name: "莫斯科店" }]}
        localShops={[]}
        onMessage={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("商品类型和图片比")).toHaveProperty("value", productImageRule.id));
    expect(screen.getByLabelText("当前套图样机")).toHaveProperty("value", otherMockupTemplate.id);
    expect(
      screen.queryAllByText("已恢复上次上架设置").length
      + screen.queryAllByText("上架设置已自动保存").length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText("莫斯科店").length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue("方巾正式模板")).toBeTruthy();
    expect(screen.getByDisplayValue("上次标题模板")).toBeTruthy();
    expect(screen.getByDisplayValue("上次提示词 {sku}")).toBeTruthy();
  });

  it("one-click listing only renders selected assets that have not rendered the current template", async () => {
    const shopId = "shop-auto-batch";
    const localTemplateId = "local-template-headscarf";
    const renderedAsset: CloudAsset = {
      ...baseAsset,
      id: "22222222-2222-4222-8222-222222222224",
      sku: "DYXSFD202606140002",
      generatedTitle: "已套图标题",
      mockupResults: Array.from({ length: 6 }, (_, index) => makeUuidMockupAsset(baseAsset, index + 1)),
    };
    const unrenderedAsset: CloudAsset = {
      ...baseAsset,
      id: "22222222-2222-4222-8222-222222222225",
      sku: "DYXSFD202606140003",
      sourceFilename: "DYXSFD202606140003.png",
      generatedTitle: "未套图标题",
    };
    const renderedImages = renderedAsset.mockupResults ?? [];
    const generatedImages = Array.from({ length: 6 }, (_, index) => ({
      ...makeUuidMockupAsset(unrenderedAsset, index + 1),
      id: uuidFor("33333333-3333-4333-8333", index + 20),
    }));
    const client = createClient([renderedAsset, unrenderedAsset]);
    const batch = makeListingBatch({
      assets: [renderedAsset, unrenderedAsset],
      imageAssetsBySourceId: {
        [renderedAsset.id]: renderedImages,
        [unrenderedAsset.id]: generatedImages,
      },
      shopId,
    });
    mockListingSetup(client, shopId, localTemplateId);
    vi.mocked(client.renderMockup).mockResolvedValue({
      ok: true,
      sourceAsset: {
        id: unrenderedAsset.id,
        sku: unrenderedAsset.sku,
        sourceFilename: unrenderedAsset.sourceFilename,
      },
      template: mockupTemplate,
      generated: 6,
      assets: generatedImages,
    });
    vi.mocked(client.createListingBatch).mockResolvedValue({ ok: true, batch });
    vi.mocked(client.getListingBatch).mockResolvedValue({ ok: true, batch });

    render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: shopId, externalShopId: shopId, name: "跟卖测试店" }]}
        localShops={[makeLocalShop(shopId)]}
        onMessage={vi.fn()}
      />,
    );

    expect(await screen.findByText("DYXSFD202606140002")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "选择本页" })[0]);
    const oneClickButton = screen.getByRole("button", { name: /选中图片一键上架/ }) as HTMLButtonElement;
    await waitFor(() => expect(oneClickButton.disabled).toBe(false));
    fireEvent.click(oneClickButton);

    await waitFor(() => expect(client.renderMockup).toHaveBeenCalledTimes(1));
    expect(client.renderMockup).toHaveBeenCalledWith(mockupTemplate.id, unrenderedAsset.id);
  });

  it("keeps one-click listing clickable and blocks after refreshing a full quota", async () => {
    const shopId = "shop-quota-full";
    const localTemplateId = "local-template-headscarf";
    const today = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
    const renderedAsset: CloudAsset = {
      ...baseAsset,
      id: "22222222-2222-4222-8222-222222222226",
      sku: "DYXSFD202606140006",
      generatedTitle: "额度测试标题",
      mockupResults: Array.from({ length: 6 }, (_, index) => makeUuidMockupAsset(baseAsset, index + 1)),
    };
    const client = createClient(renderedAsset);
    const onMessage = vi.fn();
    mockListingSetup(client, shopId, localTemplateId);
    vi.mocked(client.listDailyListingStats).mockResolvedValue({
      ok: true,
      stats: [{
        externalShopId: shopId,
        shopName: "跟卖测试店",
        date: today,
        listedCount: 280,
        reservedCount: 300,
        pendingCount: 20,
      }],
    });

    render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: shopId, externalShopId: shopId, name: "跟卖测试店" }]}
        localShops={[makeLocalShop(shopId)]}
        onMessage={onMessage}
      />,
    );

    expect(await screen.findByText(renderedAsset.sku)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`选择 ${renderedAsset.sku}`));
    const oneClickButton = screen.getByRole("button", { name: /选中图片一键上架/ }) as HTMLButtonElement;

    await waitFor(() => expect(screen.getByText(/额度不足/)).toBeTruthy());
    expect(oneClickButton.disabled).toBe(false);
    fireEvent.click(oneClickButton);
    await waitFor(() => expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("今日上架额度不足")));
    expect(client.createListingBatch).not.toHaveBeenCalled();
  });

  it("bulk deletes selected pending assets after confirmation", async () => {
    const firstAsset: CloudAsset = {
      ...baseAsset,
      id: "asset-delete-1",
      sku: "DYXSFD202606140004",
      sourceFilename: "DYXSFD202606140004.png",
    };
    const secondAsset: CloudAsset = {
      ...baseAsset,
      id: "asset-delete-2",
      sku: "DYXSFD202606140005",
      sourceFilename: "DYXSFD202606140005.png",
    };
    const client = createClient([firstAsset, secondAsset]);
    const onMessage = vi.fn();
    vi.mocked(client.deleteAsset).mockResolvedValue({ ok: true, asset: { id: firstAsset.id, sku: firstAsset.sku } });

    render(<GalleryManager mode="pending" client={client} shops={[]} onMessage={onMessage} />);

    expect(await screen.findByText("DYXSFD202606140004")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "选择本页" })[0]);

    const bulkDeleteButton = screen.getByRole("button", { name: /批量删除/ });
    fireEvent.click(bulkDeleteButton);
    expect(client.deleteAsset).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("再次点击批量删除"));

    fireEvent.click(screen.getByRole("button", { name: /确认删除 2 张/ }));

    await waitFor(() => expect(client.deleteAsset).toHaveBeenCalledTimes(2));
    expect(client.deleteAsset).toHaveBeenCalledWith(firstAsset.id);
    expect(client.deleteAsset).toHaveBeenCalledWith(secondAsset.id);
    await waitFor(() => expect(screen.queryByText("DYXSFD202606140004")).toBeNull());
    expect(screen.queryByText("DYXSFD202606140005")).toBeNull();
  });

  it("generates missing titles inside one-click listing with a per-user concurrency cap", async () => {
    const shopId = "shop-title-concurrency";
    const localTemplateId = "local-template-headscarf";
    const assets = Array.from({ length: 25 }, (_, index): CloudAsset => {
      const sku = `DYXSFD20260614${String(index + 10).padStart(4, "0")}`;
      return {
        ...baseAsset,
        id: uuidFor("22222222-2222-4222-8222", index + 10),
        sku,
        sourceFilename: `${sku}.png`,
        mockupResults: [{
          ...makeMockupAsset(1),
          id: uuidFor("33333333-3333-4333-8333", index + 10),
          sku: `${sku}-mockup-1`,
          sourceFilename: `${sku}-mockup-1.jpg`,
        }],
      };
    });
    const client = createClient(assets);
    const onMessage = vi.fn();
    const pending: Array<{
      input: Parameters<CloudClient["generateListingTitle"]>[0];
      resolve: (value: Awaited<ReturnType<CloudClient["generateListingTitle"]>>) => void;
    }> = [];
    vi.mocked(client.generateListingTitle).mockImplementation((input) => new Promise((resolve) => {
      pending.push({ input, resolve });
    }));
    mockListingSetup(client, shopId, localTemplateId);
    vi.mocked(client.createListingBatch).mockImplementation((input) => {
      const inputAssets = input.assets.map((item) => {
        const source = assets.find((asset) => asset.id === item.sourceAssetId)!;
        return { ...source, generatedTitle: item.title ?? `标题 ${item.sourceAssetId}` };
      });
      const imageAssetsBySourceId = Object.fromEntries(input.assets.map((item) => [
        item.sourceAssetId,
        item.imageAssetIds.map((imageAssetId, index) => ({
          ...makeUuidMockupAsset(assets[0], index + 1),
          id: imageAssetId,
          publicUrl: `https://example.test/${imageAssetId}.jpg`,
          thumbUrl: `https://example.test/${imageAssetId}-thumb.jpg`,
        })),
      ]));
      const batch = makeListingBatch({
        assets: inputAssets,
        imageAssetsBySourceId,
        shopId,
      });
      vi.mocked(client.getListingBatch).mockResolvedValue({ ok: true, batch });
      return Promise.resolve({ ok: true, batch });
    });

    render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: shopId, externalShopId: shopId, name: "跟卖测试店" }]}
        localShops={[makeLocalShop(shopId)]}
        onMessage={onMessage}
      />,
    );

    expect(await screen.findByText("DYXSFD202606140010")).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("10 张"), { target: { value: "40" } });
    expect(await screen.findByText("DYXSFD202606140034")).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "选择本页" })[0]);
    const oneClickButton = screen.getByRole("button", { name: /选中图片一键上架/ }) as HTMLButtonElement;
    await waitFor(() => expect(oneClickButton.disabled).toBe(false));
    fireEvent.click(oneClickButton);

    await waitFor(() => expect(client.generateListingTitle).toHaveBeenCalledTimes(20));
    expect(pending).toHaveLength(20);

    pending.splice(0).forEach(({ input, resolve }) => {
      resolve({
        ok: true,
        title: `标题 ${input.sourceAssetId}`,
        sourceAssetId: input.sourceAssetId,
        imageAssetId: input.imageAssetId,
        asset: {
          id: input.sourceAssetId,
          sku: input.sourceAssetId,
          generatedTitle: `标题 ${input.sourceAssetId}`,
          generatedTitleImageAssetId: input.imageAssetId,
          generatedTitlePrompt: "prompt",
          generatedTitleUpdatedAt: "2026-06-14T00:00:00.000Z",
        },
      });
    });

    await waitFor(() => expect(client.generateListingTitle).toHaveBeenCalledTimes(25));
    pending.splice(0).forEach(({ input, resolve }) => {
      resolve({
        ok: true,
        title: `标题 ${input.sourceAssetId}`,
        sourceAssetId: input.sourceAssetId,
        imageAssetId: input.imageAssetId,
        asset: {
          id: input.sourceAssetId,
          sku: input.sourceAssetId,
          generatedTitle: `标题 ${input.sourceAssetId}`,
          generatedTitleImageAssetId: input.imageAssetId,
          generatedTitlePrompt: "prompt",
          generatedTitleUpdatedAt: "2026-06-14T00:00:00.000Z",
        },
      });
    });

    await waitFor(() => expect(client.createListingBatch).toHaveBeenCalled());
  });

  it("keeps titled assets moving when another title repeatedly fails", async () => {
    const shopId = "shop-partial-title";
    const localTemplateId = "local-template-partial-title";
    const successfulAsset = {
      ...baseAsset,
      id: "22222222-2222-4222-8222-222222222261",
      sku: "PARTIAL-TITLE-OK",
      sourceFilename: "PARTIAL-TITLE-OK.png",
      mockupResults: [{
        ...makeMockupAsset(1),
        id: "33333333-3333-4333-8333-333333333361",
        sku: "PARTIAL-TITLE-OK-mockup",
        sourceFilename: "PARTIAL-TITLE-OK-mockup.jpg",
      }],
    } satisfies CloudAsset;
    const failedAsset = {
      ...baseAsset,
      id: "22222222-2222-4222-8222-222222222262",
      sku: "PARTIAL-TITLE-FAIL",
      sourceFilename: "PARTIAL-TITLE-FAIL.png",
      mockupResults: [{
        ...makeMockupAsset(1),
        id: "33333333-3333-4333-8333-333333333362",
        sku: "PARTIAL-TITLE-FAIL-mockup",
        sourceFilename: "PARTIAL-TITLE-FAIL-mockup.jpg",
      }],
    } satisfies CloudAsset;
    const assets = [successfulAsset, failedAsset];
    const client = createClient(assets);
    const onMessage = vi.fn();
    mockListingSetup(client, shopId, localTemplateId);
    vi.mocked(client.generateListingTitle).mockImplementation(async (input) => {
      if (input.sourceAssetId === failedAsset.id) {
        throw new Error("title provider unavailable");
      }
      return {
        ok: true,
        title: "Valid generated title",
        sourceAssetId: input.sourceAssetId,
        imageAssetId: input.imageAssetId,
        asset: {
          id: input.sourceAssetId,
          sku: successfulAsset.sku,
          generatedTitle: "Valid generated title",
          generatedTitleImageAssetId: input.imageAssetId,
          generatedTitlePrompt: "prompt",
          generatedTitleUpdatedAt: "2026-07-15T00:00:00.000Z",
        },
      };
    });
    vi.mocked(client.createListingBatch).mockImplementation((input) => {
      const batch = makeListingBatch({
        assets: [successfulAsset],
        imageAssetsBySourceId: {
          [successfulAsset.id]: successfulAsset.mockupResults ?? [],
        },
        shopId,
      });
      batch.imageSets[0].title = input.assets[0]?.title ?? null;
      return Promise.resolve({ ok: true, batch });
    });

    render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: shopId, externalShopId: shopId, name: "Partial title shop" }]}
        localShops={[makeLocalShop(shopId)]}
        onMessage={onMessage}
      />,
    );

    expect(await screen.findByText(successfulAsset.sku)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "选择本页" })[0]);
    const oneClickButton = screen.getByRole("button", { name: /选中图片一键上架/ }) as HTMLButtonElement;
    await waitFor(() => expect(oneClickButton.disabled).toBe(false));
    fireEvent.click(oneClickButton);

    await waitFor(() => expect(client.createListingBatch).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    const batchInput = vi.mocked(client.createListingBatch).mock.calls[0][0];
    expect(batchInput.assets.map((item) => item.sourceAssetId)).toEqual([successfulAsset.id]);
    expect(vi.mocked(client.generateListingTitle).mock.calls.filter(([input]) => input.sourceAssetId === failedAsset.id)).toHaveLength(3);
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("其余 1 个商品继续上架"));
  }, 12_000);
  it("starts the full auto listing workflow from one click after image and shop settings are selected", async () => {
    const sourceAssetId = "22222222-2222-4222-8222-222222222222";
    const mockupAssetId = "33333333-3333-4333-8333-333333333333";
    const batchId = "11111111-1111-4111-8111-111111111111";
    const shopId = "shop-follow-2";
    const localTemplateId = "local-template-headscarf";
    const localTemplatePayload = { offer_id: "TEMPLATE", name: "妯℃澘鍟嗗搧", images: [] };
    const renderedAsset: CloudAsset = {
      ...baseAsset,
      id: sourceAssetId,
      sku: "DYXSFD202607050001",
      sourceFilename: "DYXSFD202607050001.png",
      generatedTitle: "头巾方巾测试标题",
      mockupResults: [{
        ...makeMockupAsset(1),
        id: mockupAssetId,
        sku: "DYXSFD202607050001-fangjin-01",
        sourceFilename: "DYXSFD202607050001-fangjin-01.jpg",
      }],
    };
    const batch: CloudListingBatch = {
      id: batchId,
      status: "prepared",
      ratioFamily: "square",
      mockupTemplateId: mockupTemplate.id,
      mockupTemplateName: mockupTemplate.name,
      titlePromptTemplateId: null,
      titlePromptTemplateName: null,
      titlePrompt: null,
      imageSets: [{
        externalShopId: shopId,
        shopName: "跟卖2店",
        productTemplateName: "头巾模板",
        sourceAssetId,
        sourceSku: renderedAsset.sku,
        sourceUrl: renderedAsset.publicUrl,
        sourceThumbUrl: renderedAsset.thumbUrl,
        imageAssetIds: [mockupAssetId],
        imageUrls: ["https://example.test/fangjin-01.jpg"],
        configSnapshot: {
          externalShopId: shopId,
          localShopId: shopId,
          localTemplateId,
          productTemplateId: "cloud-template-headscarf",
          productTemplateName: "headscarf-template",
          templateProduct: localTemplatePayload,
          autoGenerateBarcode: true,
          autoUpdateStock: false,
          autoAddToAction: false,
          postListingDelayMinutes: 3,
          actionDelayMinutes: 0,
          actionRetryCount: 72,
          actionRetryIntervalMinutes: 10,
        },
        title: "头巾方巾测试标题",
      }],
      shopTargets: [{
        externalShopId: shopId,
        shopName: "跟卖2店",
        productTemplateId: "cloud-template-headscarf",
        productTemplateName: "头巾模板",
        status: "prepared",
        uploadedAt: null,
        error: null,
        configSnapshot: {
          externalShopId: shopId,
          localShopId: shopId,
          localTemplateId,
          productTemplateId: "cloud-template-headscarf",
          productTemplateName: "headscarf-template",
          templateProduct: localTemplatePayload,
          autoGenerateBarcode: true,
          autoUpdateStock: false,
          autoAddToAction: false,
          postListingDelayMinutes: 3,
          actionDelayMinutes: 0,
          actionRetryCount: 72,
          actionRetryIntervalMinutes: 10,
        },
      }],
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
    };
    const client = createClient(renderedAsset);
    const onNavigate = vi.fn();
    const onJobStarted = vi.fn();
    vi.mocked(api.listTemplates).mockResolvedValue([{
      id: localTemplateId,
      kind: "product_import",
      name: "方巾",
      payload: localTemplatePayload,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
    }]);
    vi.mocked(client.getListingPreferences).mockResolvedValue({
      ok: true,
      updatedAt: "2026-07-05T00:00:00.000Z",
      preferences: {
        ratioFamily: "square",
        selectedShopId: shopId,
        selectedMockupTemplate: mockupTemplate.id,
        shopListingConfigs: [{
          externalShopId: shopId,
          productTemplateId: "cloud-template-headscarf",
          productTemplateName: "头巾模板",
          newTemplateName: "头巾模板",
          localTemplateId,
          autoGenerateBarcode: true,
          autoUpdateStock: false,
          autoAddToAction: false,
        }],
      },
    });
    vi.mocked(client.createListingBatch).mockResolvedValue({ ok: true, batch });
    vi.mocked(client.getListingBatch).mockResolvedValue({ ok: true, batch });

    render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: shopId, externalShopId: shopId, name: "跟卖2店", ozonClientId: "5127411" }]}
        localShops={[{
          id: shopId,
          name: "跟卖2店",
          clientId: "5127411",
          apiKeyStored: true,
          ossAccessKeyStored: true,
          ozonSellerCookieStored: false,
          enabled: true,
          createdAt: "2026-07-05T00:00:00.000Z",
          updatedAt: "2026-07-05T00:00:00.000Z",
        }]}
        cloudApiBaseUrl="https://api.example.test"
        onMessage={vi.fn()}
        onJobStarted={onJobStarted}
        onNavigate={onNavigate}
      />,
    );

    expect(await screen.findByText("DYXSFD202607050001")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(`选择 ${renderedAsset.sku}`));
    const oneClickButton = screen.getByRole("button", { name: /选中图片一键上架/ }) as HTMLButtonElement;
    await waitFor(() => expect(oneClickButton.disabled).toBe(false));
    fireEvent.click(oneClickButton);

    await waitFor(() => expect(client.createListingBatch).toHaveBeenCalledWith(expect.objectContaining({
      productImageRuleId: productImageRule.id,
      mockupTemplateId: mockupTemplate.id,
      shopTargets: [expect.objectContaining({
        externalShopId: shopId,
        configSnapshot: expect.objectContaining({
          dailyListingLimit: 300,
        }),
        name: "头巾模板",
      })],
      assets: [expect.objectContaining({
        sourceAssetId,
        externalShopId: shopId,
        imageAssetIds: [mockupAssetId],
        title: "头巾方巾测试标题",
      })],
    })));
    await waitFor(() => expect(api.startAutoListing).toHaveBeenCalledWith(expect.objectContaining({
      batchId,
      cloudExternalShopIdByShopId: {
        [shopId]: shopId,
      },
      mockupTemplateId: mockupTemplate.id,
      items: [expect.objectContaining({
        sourceAssetId,
        sourceSku: renderedAsset.sku,
        shopId,
        title: "头巾方巾测试标题",
        imageUrls: ["https://example.test/fangjin-01.jpg"],
      })],
    })));
    expect(onJobStarted).toHaveBeenCalledWith(expect.objectContaining({ kind: "auto_listing" }));
    expect(onNavigate).not.toHaveBeenCalledWith("imageProcessing");
    expect(client.listAssets).toHaveBeenCalledWith(expect.objectContaining({
      listingStatus: "pending",
      excludeAssetIds: expect.arrayContaining([sourceAssetId]),
    }));
  });

  it("resumes an old processing batch and reveals assignments only after expansion", async () => {
    const sourceAssetId = "55555555-5555-4555-8555-555555555555";
    const batchId = "66666666-6666-4666-8666-666666666666";
    const shopId = "shop-follow-1";
    const localTemplateId = "local-template-follow-1";
    const localTemplatePayload = { offer_id: "TEMPLATE-OLD", name: "跟卖1模板商品", images: [] };
    const imageUrls = ["https://example.test/old-batch-rendered-01.jpg"];
    const processingAsset: CloudAsset = {
      ...baseAsset,
      id: sourceAssetId,
      sku: "Z3BLCuUwgU",
      sourceFilename: "Z3BLCuUwgU.png",
      generatedTitle: "旧批次已生成标题",
      mockupResults: [makeMockupAsset(1)],
      listingStatus: {
        batchId,
        status: "prepared",
        title: "旧批次已生成标题",
        uploadedAt: null,
        progress: 0,
        stage: "queued",
        stageMessage: "waiting",
        shops: [{
          externalShopId: shopId,
          shopName: "跟卖1",
          productTemplateName: "跟卖1商品模板",
          status: "prepared",
        }],
      },
    };
    const oldBatch: CloudListingBatch = {
      id: batchId,
      status: "prepared",
      ratioFamily: "square",
      mockupTemplateId: mockupTemplate.id,
      mockupTemplateName: mockupTemplate.name,
      titlePromptTemplateId: null,
      titlePromptTemplateName: null,
      titlePrompt: null,
      imageSets: [{
        externalShopId: shopId,
        shopName: "跟卖1",
        productTemplateName: "跟卖1商品模板",
        sourceAssetId,
        sourceSku: processingAsset.sku,
        sourceUrl: processingAsset.publicUrl,
        sourceThumbUrl: processingAsset.thumbUrl,
        imageAssetIds: ["77777777-7777-4777-8777-777777777777"],
        imageUrls,
        title: "旧批次已生成标题",
        configSnapshot: null,
      }],
      shopTargets: [{
        externalShopId: shopId,
        shopName: "跟卖1",
        productTemplateId: "cloud-template-follow-1",
        productTemplateName: "跟卖1商品模板",
        status: "prepared",
        uploadedAt: null,
        error: null,
        configSnapshot: null,
      }],
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
    };
    const client = createClient(processingAsset);
    const onMessage = vi.fn();
    vi.mocked(api.listTemplates).mockResolvedValue([{
      id: localTemplateId,
      kind: "product_import",
      name: "跟卖1模板",
      payload: localTemplatePayload,
      createdAt: "2026-07-06T00:00:00.000Z",
      updatedAt: "2026-07-06T00:00:00.000Z",
    }]);
    vi.mocked(client.getListingPreferences).mockResolvedValue({
      ok: true,
      updatedAt: "2026-07-06T00:00:00.000Z",
      preferences: {
        ratioFamily: "square",
        selectedShopId: shopId,
        selectedMockupTemplate: mockupTemplate.id,
        shopListingConfigs: [{
          externalShopId: shopId,
          productTemplateId: "cloud-template-follow-1",
          productTemplateName: "跟卖1商品模板",
          newTemplateName: "跟卖1商品模板",
          localTemplateId,
          autoGenerateBarcode: true,
          autoUpdateStock: false,
          autoAddToAction: false,
        }],
      },
    });
    vi.mocked(client.getListingBatch).mockResolvedValue({ ok: true, batch: oldBatch });

    render(
      <GalleryManager
        mode="processing"
        client={client}
        shops={[{ id: shopId, externalShopId: shopId, name: "跟卖1", ozonClientId: "5127411" }]}
        localShops={[{
          id: shopId,
          name: "跟卖1",
          clientId: "5127411",
          apiKeyStored: true,
          ossAccessKeyStored: true,
          ozonSellerCookieStored: false,
          enabled: true,
          createdAt: "2026-07-06T00:00:00.000Z",
          updatedAt: "2026-07-06T00:00:00.000Z",
        }]}
        cloudApiBaseUrl="https://api.example.test"
        onMessage={onMessage}
      />,
    );

    expect(await screen.findByText("手动批次")).toBeTruthy();
    expect(screen.queryByText("Z3BLCuUwgU")).toBeNull();
    const legacyTaskCard = screen.getByText("手动批次").closest(".task-card");
    expect(legacyTaskCard).toBeTruthy();
    fireEvent.click(within(legacyTaskCard as HTMLElement).getByRole("button", { name: "展开图片明细" }));
    expect(await screen.findByText("Z3BLCuUwgU")).toBeTruthy();
    await waitFor(() => expect(api.startAutoListing).toHaveBeenCalledWith(expect.objectContaining({
      batchId,
      cloudExternalShopIdByShopId: {
        [shopId]: shopId,
      },
      items: [expect.objectContaining({
        sourceAssetId,
        sourceSku: "Z3BLCuUwgU",
        shopId,
        title: "旧批次已生成标题",
        imageUrls,
      })],
      shopConfigs: [expect.objectContaining({
        shopId,
        templateProduct: localTemplatePayload,
        autoUpdateStock: false,
        autoAddToAction: false,
      })],
    })));
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("旧版本生成"));
  });

  it("does not discover unrelated cloud batches when manually resuming uploads", async () => {
    const client = createClient([]);
    vi.mocked(client.listAssets).mockResolvedValue({ ok: true, assets: [], total: 0, limit: 10, offset: 0 });
    const onMessage = vi.fn();

    render(<GalleryManager mode="processing" client={client} shops={[]} onMessage={onMessage} />);

    fireEvent.click(await screen.findByRole("button", { name: /批量恢复上传/ }));

    expect(client.listListingBatches).not.toHaveBeenCalled();
    expect(api.startAutoListing).not.toHaveBeenCalled();
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("当前 400 个商品"));
  });
  it("keeps legacy batch assignments hidden until the task card is expanded", async () => {
    const batchId = "88888888-8888-4888-8888-888888888888";
    const processingAssets: CloudAsset[] = Array.from({ length: 12 }, (_, index) => {
      const number = index + 1;
      return {
        ...baseAsset,
        id: uuidFor("88888888-8888-4888-8888", number),
        sku: `LOCAL-${String(number).padStart(2, "0")}`,
        sourceFilename: `LOCAL-${String(number).padStart(2, "0")}.jpg`,
        createdAt: `2026-07-11T00:${String(number).padStart(2, "0")}:00.000Z`,
        listingStatus: {
          batchId,
          status: "prepared",
          title: `本地处理中 ${number}`,
          uploadedAt: null,
          progress: 2,
          stage: "mockup",
          stageMessage: "本地助手正在后台套图",
          shops: [{
            externalShopId: "shop-local-processing",
            shopName: "跟卖分页店",
            productTemplateName: "头巾模板",
            status: "prepared",
          }],
        },
      };
    });
    window.localStorage.setItem(
      "ozon-sjsq:gallery-local-processing:v1:default",
      JSON.stringify(processingAssets.map((asset) => ({ asset, savedAt: Date.now() }))),
    );
    const client = createClient([]);
    vi.mocked(client.listAssets).mockResolvedValue({ ok: true, assets: processingAssets, total: processingAssets.length, limit: 1, offset: 0 });
    vi.mocked(client.getListingBatch).mockResolvedValue({
      ok: true,
      batch: {
        id: batchId,
        status: "prepared",
        ratioFamily: "square",
        mockupTemplateId: mockupTemplate.id,
        mockupTemplateName: mockupTemplate.name,
        titlePromptTemplateId: null,
        titlePromptTemplateName: null,
        titlePrompt: null,
        imageSets: processingAssets.map((asset) => ({
          externalShopId: "shop-local-processing",
          shopName: "璺熷崠鍒嗛〉搴?",
          productTemplateName: "澶村肪妯℃澘",
          sourceAssetId: asset.id,
          sourceSku: asset.sku,
          sourceUrl: asset.publicUrl,
          sourceThumbUrl: asset.thumbUrl,
          imageAssetIds: [],
          imageUrls: [],
          configSnapshot: null,
          title: asset.generatedTitle ?? `鏍囬 ${asset.id}`,
        })),
        shopTargets: [{
          externalShopId: "shop-local-processing",
          shopName: "璺熷崠鍒嗛〉搴?",
          productTemplateId: "cloud-template-local-processing",
          productTemplateName: "澶村肪妯℃澘",
          status: "prepared",
          uploadedAt: null,
          error: null,
          configSnapshot: null,
        }],
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
    });

    render(<GalleryManager mode="processing" client={client} shops={[]} onMessage={vi.fn()} />);

    expect(screen.getByText("批次任务中心")).toBeTruthy();
    expect(screen.queryByText("手动批次")).toBeNull();
    expect(screen.queryByText("LOCAL-12")).toBeNull();
    expect(client.getListingBatch).not.toHaveBeenCalled();
  });

  it("does not refresh local processing cache age while rendering processing page", async () => {
    const savedAt = Date.now() - 60 * 60 * 1000;
    const processingAsset: CloudAsset = {
      ...baseAsset,
      id: "12121212-1212-4212-8212-121212121212",
      sku: "CACHE-AGE-01",
      listingStatus: {
        batchId: "",
        status: "prepared",
        title: "cached title",
        uploadedAt: null,
        progress: 2,
        stage: "mockup",
        stageMessage: "本地助手正在后台套图",
        shops: [],
      },
    };
    window.localStorage.setItem(
      "ozon-sjsq:gallery-local-processing:v1:default",
      JSON.stringify([{ asset: processingAsset, savedAt }]),
    );
    const client = createClient([]);
    vi.mocked(client.listAssets).mockResolvedValue({ ok: true, assets: [], total: 0, limit: 10, offset: 0 });

    render(<GalleryManager mode="processing" client={client} shops={[]} onMessage={vi.fn()} />);

    await waitFor(() => expect(client.listAssets).toHaveBeenCalled());
    await new Promise((resolve) => window.setTimeout(resolve, 1700));

    const stored = JSON.parse(window.localStorage.getItem("ozon-sjsq:gallery-local-processing:v1:default") || "[]") as Array<{ savedAt: number }>;
    expect(stored[0]?.savedAt).toBe(savedAt);
  });

  it("uses reconciliation processing count for the processing overview total", async () => {
    const processingAssets: CloudAsset[] = Array.from({ length: 10 }, (_, index) => ({
      ...baseAsset,
      id: uuidFor("23232323-2323-4323-8323", index + 1),
      sku: `PROCESSING-${String(index + 1).padStart(2, "0")}`,
      listingStatus: {
        batchId: "34343434-3434-4343-8343-343434343434",
        status: "prepared",
        title: "processing title",
        uploadedAt: null,
        progress: 20,
        stage: "batch",
        stageMessage: "processing",
        shops: [],
      },
    }));
    const client = createClient([]);
    vi.mocked(client.listAssets).mockResolvedValue({ ok: true, assets: processingAssets, total: 15380, limit: 10, offset: 0 });
    vi.mocked(client.listListingReconciliation).mockResolvedValue({
      ok: true,
      summary: {
        dateFrom: "2026-07-28",
        dateTo: "2026-07-28",
        total: 53,
        completedCount: 0,
        failedCount: 0,
        processingCount: 53,
        mockupRunningCount: 0,
        titleRunningCount: 0,
        listingRunningCount: 0,
        shops: [],
        batches: [],
      },
    });

    render(<GalleryManager mode="processing" client={client} shops={[]} onMessage={vi.fn()} />);

    await waitFor(() => expect(client.listListingReconciliation).toHaveBeenCalled());
    expect(screen.getByText("批次任务中心")).toBeTruthy();
    const totalCard = screen.getByText("总计").closest(".auto-listing-task-metric");
    expect(totalCard).toBeTruthy();
    expect(within(totalCard as HTMLElement).getByText("53")).toBeTruthy();
    expect(within(totalCard as HTMLElement).queryByText(/15380/)).toBeNull();
  });

  it("keeps cached processing assets hidden when cloud results are empty", async () => {
    const cachedAssets: CloudAsset[] = Array.from({ length: 12 }, (_, index) => ({
      ...baseAsset,
      id: uuidFor("99999999-9999-4999-8999", index + 1),
      sku: `CACHED-${String(index + 1).padStart(2, "0")}`,
      productImageRuleId: productImageRule.id,
      listingStatus: { batchId: "", status: "prepared", title: "cached title", uploadedAt: null, progress: 2, stage: "mockup", stageMessage: "cached", shops: [] },
    }));
    window.localStorage.setItem("ozon-sjsq:gallery-local-processing:v1:default", JSON.stringify(cachedAssets.map((asset) => ({ asset, savedAt: Date.now() }))));
    const client = createClient([]);
    vi.mocked(client.listAssets).mockResolvedValue({ ok: true, assets: [], total: 0, limit: 10, offset: 0 });
    vi.mocked(client.listListingReconciliation).mockResolvedValue({
      ok: true,
      summary: {
        dateFrom: "2026-07-28",
        dateTo: "2026-07-28",
        total: 53,
        completedCount: 0,
        failedCount: 0,
        processingCount: 53,
        mockupRunningCount: 0,
        titleRunningCount: 0,
        listingRunningCount: 0,
        shops: [],
        batches: [],
      },
    });

    render(<GalleryManager mode="processing" client={client} shops={[]} onMessage={vi.fn()} />);

    await waitFor(() => expect(client.listAssets).toHaveBeenCalledWith(expect.objectContaining({ listingStatus: "processing" })));
    expect(screen.getByText("批次任务中心")).toBeTruthy();
    const totalCard = screen.getByText("总计").closest(".auto-listing-task-metric");
    expect(within(totalCard as HTMLElement).getByText("53")).toBeTruthy();
    expect(screen.queryAllByText(/^CACHED-/)).toHaveLength(0);
    expect(screen.queryByRole("combobox")).toBeNull();
  });

  it("clears stale local batch records when the cloud processing list is empty", async () => {
    const staleAsset: CloudAsset = {
      ...baseAsset,
      id: "77777777-7777-4777-8777-777777777777",
      sku: "STALE-BATCH-01",
      listingStatus: {
        batchId: "66666666-6666-4666-8666-666666666666",
        status: "prepared",
        title: "old title",
        uploadedAt: null,
        progress: 35,
        stage: "ready",
        stageMessage: "waiting",
        shops: [],
      },
    };
    window.localStorage.setItem(
      "ozon-sjsq:gallery-local-processing:v1:default",
      JSON.stringify([{ asset: staleAsset, savedAt: Date.now() }]),
    );
    const client = createClient([]);
    vi.mocked(client.listAssets).mockResolvedValue({ ok: true, assets: [], total: 0, limit: 10, offset: 0 });

    render(<GalleryManager mode="processing" client={client} shops={[]} onMessage={vi.fn()} />);

    await waitFor(() => expect(client.listAssets).toHaveBeenCalled());
    expect(screen.queryByText("STALE-BATCH-01")).toBeNull();
    await waitFor(() => expect(window.localStorage.getItem("ozon-sjsq:gallery-local-processing:v1:default")).toBeNull());
  });

  it("keeps background gallery upload jobs visible with pagination and logs", async () => {
    const jobs: JobSummary[] = Array.from({ length: 12 }, (_, index) => {
      const number = index + 1;
      return {
        id: `gallery-job-${number}`,
        kind: "gallery_upload",
        title: `后台任务 ${number}`,
        status: number === 12 ? "running" : "succeeded",
        progress: number === 12 ? 45 : 100,
        successCount: number,
        failedCount: 0,
        createdAt: `2026-06-14T00:${String(number).padStart(2, "0")}:00.000Z`,
        updatedAt: `2026-06-14T00:${String(number).padStart(2, "0")}:00.000Z`,
      };
    });
    vi.mocked(api.listJobs).mockResolvedValue(jobs);
    vi.mocked(api.listJobLogs).mockResolvedValue([
      {
        id: "log-gallery-12",
        jobId: "gallery-job-12",
        level: "info",
        message: "正在上传第 12 个任务",
        createdAt: "2026-06-14T00:12:30.000Z",
      },
    ]);

    render(<GalleryManager mode="upload" client={createClient(baseAsset)} shops={[]} onMessage={vi.fn()} />);

    expect(await screen.findByText("后台上传任务")).toBeTruthy();
    expect(await screen.findByText("后台任务 12")).toBeTruthy();
    expect(screen.queryByText("后台任务 1")).toBeNull();

    fireEvent.click(screen.getAllByText("日志")[0]);
    expect(await screen.findByText("正在上传第 12 个任务")).toBeTruthy();
    expect(api.listJobLogs).toHaveBeenCalledWith("gallery-job-12");

    fireEvent.click(screen.getByText("下一页"));
    expect(await screen.findByText("后台任务 1")).toBeTruthy();
  });

  it("waits for shops after preferences settle before becoming ready or autosaving", async () => {
    const client = createClient(baseAsset);
    const cloudShopSource = createDeferred<Awaited<ReturnType<CloudClient["listShops"]>>>();
    const localShopSource = createDeferred<Awaited<ReturnType<typeof api.loadAppState>>>();
    vi.mocked(client.listShops).mockReturnValue(cloudShopSource.promise);
    vi.mocked(api.loadAppState).mockReturnValue(localShopSource.promise);
    vi.mocked(client.getListingPreferences).mockResolvedValue({
      ok: true,
      updatedAt: "2026-07-27T00:00:00.000Z",
      preferences: {
        shopListingConfigs: [{
          externalShopId: "shop-late",
          productTemplateId: "cloud-template-late",
          productTemplateName: "Late saved template",
          newTemplateName: "Late saved template",
          localTemplateId: "local-template-late",
        }],
      },
    });

    const view = render(
      <GalleryManager mode="pending" client={client} shops={[]} localShops={[]} onMessage={vi.fn()} />,
    );

    await waitFor(() => {
      expect(client.getListingPreferences).toHaveBeenCalled();
      expect(client.listShops).toHaveBeenCalled();
      expect(api.loadAppState).toHaveBeenCalled();
    });
    const manualSaveButton = Array.from(view.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("保存上架设置"));
    expect(manualSaveButton).toBeTruthy();
    expect(manualSaveButton!.disabled).toBe(true);
    expect(client.saveListingPreferences).not.toHaveBeenCalled();

    view.rerender(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: "cloud-shop-late", externalShopId: "shop-late", name: "Late Shop" }]}
        localShops={[makeLocalShop("shop-late", "Late Local Shop")]}
        onMessage={vi.fn()}
      />,
    );

    await waitFor(() => expect(findListingRow(view.container, "shop-late")?.querySelector<HTMLInputElement>("input")?.value).toBe("Late saved template"));
  });

  it("uses shops that arrive before preferences when building the initial setup", async () => {
    const client = createClient(baseAsset);
    const preferences = createDeferred<Awaited<ReturnType<CloudClient["getListingPreferences"]>>>();
    const cloudShopSource = createDeferred<Awaited<ReturnType<CloudClient["listShops"]>>>();
    const localShopSource = createDeferred<Awaited<ReturnType<typeof api.loadAppState>>>();
    vi.mocked(client.getListingPreferences).mockReturnValue(preferences.promise);
    vi.mocked(client.listShops).mockReturnValue(cloudShopSource.promise);
    vi.mocked(api.loadAppState).mockReturnValue(localShopSource.promise);
    const view = render(
      <GalleryManager mode="pending" client={client} shops={[]} localShops={[]} onMessage={vi.fn()} />,
    );

    view.rerender(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: "cloud-shop-first", externalShopId: "shop-first", name: "First Shop" }]}
        localShops={[makeLocalShop("shop-first", "First Local Shop")]}
        onMessage={vi.fn()}
      />,
    );
    expect(client.saveListingPreferences).not.toHaveBeenCalled();

    preferences.resolve({
      ok: true,
      updatedAt: "2026-07-27T00:00:00.000Z",
      preferences: {
        shopListingConfigs: [{
          externalShopId: "shop-first",
          productTemplateId: "cloud-template-first",
          productTemplateName: "First saved template",
          newTemplateName: "First saved template",
          localTemplateId: "local-template-first",
        }],
      },
    });
    await waitFor(() => expect(findListingRow(view.container, "shop-first")?.querySelector<HTMLInputElement>("input")?.value).toBe("First saved template"));
  });
  it("does not autosave listing defaults before every setup source settles", async () => {
    const client = createClient(baseAsset);
    const productTemplates = createDeferred<{ ok: boolean; templates: CloudProductTemplate[] }>();
    const localTemplates = createDeferred<Awaited<ReturnType<typeof api.listTemplates>>>();
    vi.mocked(client.getListingPreferences).mockResolvedValue({
      ok: true,
      updatedAt: "2026-07-27T00:00:00.000Z",
      preferences: {
        shopListingConfigs: [{
          externalShopId: "shop-a",
          productTemplateId: "saved-cloud-template",
          productTemplateName: "Saved template",
          localTemplateId: "saved-local-template",
        }],
      },
    });
    vi.mocked(client.listProductTemplates).mockReturnValue(productTemplates.promise);
    vi.mocked(api.listTemplates).mockReturnValue(localTemplates.promise);

    render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: "cloud-shop-a", externalShopId: "shop-a", name: "Shop A" }]}
        localShops={[]}
        onMessage={vi.fn()}
      />,
    );

    window.setTimeout(() => {
      productTemplates.resolve({ ok: true, templates: [] });
      localTemplates.resolve([]);
    }, 1500);
    await waitForDelay(1000);
    const autosaveCallsBeforeReady = vi.mocked(client.saveListingPreferences).mock.calls.length;
    await Promise.all([productTemplates.promise, localTemplates.promise]);

    expect(autosaveCallsBeforeReady).toBe(0);
  });

  it("keeps autosave available after a non-critical setup source fails", async () => {
    const client = createClient(baseAsset);
    const onMessage = vi.fn();
    vi.mocked(client.listTitlePromptTemplates).mockRejectedValue(new Error("prompt templates unavailable"));
    vi.mocked(client.getListingPreferences).mockResolvedValue({
      ok: true,
      updatedAt: "2026-07-27T00:00:00.000Z",
      preferences: {
        shopListingConfigs: [{
          externalShopId: "shop-a",
          productTemplateName: "Editable template",
          newTemplateName: "Editable template",
        }],
      },
    });
    vi.mocked(client.saveListingPreferences).mockImplementation(async (preferences) => ({
      ok: true,
      preferences,
      updatedAt: "2026-07-27T00:01:00.000Z",
    }));

    const { container } = render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: "cloud-shop-a", externalShopId: "shop-a", name: "Shop A" }]}
        localShops={[]}
        onMessage={onMessage}
      />,
    );

    await waitFor(() => expect(findListingRow(container, "shop-a")?.querySelector<HTMLInputElement>("input")?.value).toBe("Editable template"));
    expect(onMessage).toHaveBeenCalledWith(expect.stringContaining("prompt templates unavailable"));
    vi.mocked(client.saveListingPreferences).mockClear();
    fireEvent.change(findListingRow(container, "shop-a")!.querySelector<HTMLInputElement>("input")!, {
      target: { value: "Edited after partial failure" },
    });

    await waitFor(() => expect(client.saveListingPreferences).toHaveBeenCalledWith(expect.objectContaining({
      shopListingConfigs: [expect.objectContaining({
        externalShopId: "shop-a",
        productTemplateName: "Edited after partial failure",
      })],
    })), { timeout: 1500 });
  });

  it("keeps unavailable saved templates visible and groups every cloud template", async () => {
    const client = createClient(baseAsset);
    const templates = Array.from({ length: 12 }, (_, index): CloudProductTemplate => ({
      id: `cloud-template-${index}`,
      externalShopId: index < 2 ? "__shared__" : index < 7 ? "shop-a" : "shop-other",
      shopName: index < 2 ? "All shops" : index < 7 ? "Shop A" : "Other shop",
      shared: index < 2,
      name: index < 2 ? `Shared template ${index}` : index < 7 ? `Current template ${index}` : `Other template ${index}`,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    }));
    vi.mocked(client.listProductTemplates).mockResolvedValue({ ok: true, templates });
    vi.mocked(client.getListingPreferences).mockResolvedValue({
      ok: true,
      updatedAt: "2026-07-27T00:00:00.000Z",
      preferences: {
        shopListingConfigs: [{
          externalShopId: "shop-a",
          productTemplateId: "missing-cloud-template",
          productTemplateName: "Removed cloud template",
          newTemplateName: "Removed cloud template",
          localTemplateId: "missing-local-template",
        }],
      },
    });
    vi.mocked(api.listTemplates).mockResolvedValue(Array.from({ length: 11 }, (_, index) => ({
      id: `local-template-${index}`,
      kind: "product_import",
      name: `Local template ${index}`,
      payload: {},
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    })));

    const { container } = render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={[{ id: "cloud-shop-a", externalShopId: "shop-a", name: "Shop A" }]}
        localShops={[]}
        onMessage={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(Array.from(container.querySelectorAll("select")).some((select) => select.value === "missing-cloud-template")).toBe(true);
      expect(Array.from(container.querySelectorAll("select")).some((select) => select.value === "missing-local-template")).toBe(true);
    });
    expect(screen.getByText("云端模板不可用")).toBeTruthy();
    expect(screen.getByText("本地 Ozon 模板不可用")).toBeTruthy();
    expect(Array.from(container.querySelectorAll("optgroup")).map((group) => group.label)).toEqual(expect.arrayContaining([
      "所有店铺共享",
      "当前店铺模板",
      "其他店铺模板",
    ]));
    expect(screen.getByText("Other template 11")).toBeTruthy();
    expect(screen.getByText("Local template 10")).toBeTruthy();
  });

  it("saves a delayed template into the complete latest preference snapshot", async () => {
    const client = createClient(baseAsset, [mockupTemplate, otherMockupTemplate]);
    const templates: CloudProductTemplate[] = ["a", "b"].map((suffix) => ({
      id: `cloud-template-${suffix}`,
      externalShopId: `shop-${suffix}`,
      shopName: `Shop ${suffix.toUpperCase()}`,
      shared: false,
      name: `Template ${suffix.toUpperCase()}`,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    }));
    const saveTemplate = createDeferred<Awaited<ReturnType<CloudClient["saveProductTemplate"]>>>();
    vi.mocked(client.listProductTemplates).mockResolvedValue({ ok: true, templates });
    vi.mocked(client.getListingPreferences).mockResolvedValue({
      ok: true,
      updatedAt: "2026-07-27T00:00:00.000Z",
      preferences: {
        shopListingConfigs: templates.map((template) => ({
          externalShopId: template.externalShopId,
          productTemplateId: template.id,
          productTemplateName: template.name,
          newTemplateName: template.name,
        })),
      },
    });
    vi.mocked(client.saveProductTemplate).mockReturnValue(saveTemplate.promise);
    vi.mocked(client.saveListingPreferences).mockImplementation(async (preferences) => ({
      ok: true,
      preferences,
      updatedAt: "2026-07-27T00:01:00.000Z",
    }));

    const { container } = render(
      <GalleryManager
        mode="pending"
        client={client}
        shops={["a", "b", "c"].map((suffix) => ({
          id: `cloud-shop-${suffix}`,
          externalShopId: `shop-${suffix}`,
          name: `Shop ${suffix.toUpperCase()}`,
        }))}
        localShops={[]}
        onMessage={vi.fn()}
      />,
    );

    await waitFor(() => expect(findListingRow(container, "shop-b")?.querySelector<HTMLInputElement>("input")?.value).toBe("Template B"));
    const shopCButtons = findListingRow(container, "shop-c")!.querySelectorAll<HTMLButtonElement>(".listing-shop-actions button");
    fireEvent.click(shopCButtons[1]);
    await waitFor(() => expect(findListingRow(container, "shop-c")).toBeUndefined());
    await waitForDelay(1000);
    vi.mocked(client.saveListingPreferences).mockClear();
    fireEvent.click(findListingRow(container, "shop-a")!.querySelector<HTMLButtonElement>(".listing-shop-actions button")!);
    await waitFor(() => expect(client.saveProductTemplate).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText("当前套图样机"), { target: { value: otherMockupTemplate.id } });
    fireEvent.change(findListingRow(container, "shop-b")!.querySelector<HTMLSelectElement>("select")!, { target: { value: "shop-c" } });
    expect(findListingRow(container, "shop-c")).toBeTruthy();

    saveTemplate.resolve({
      ok: true,
      template: {
        ...templates[0],
        id: "cloud-template-a-new",
        name: "Template A saved",
      },
    });

    await waitFor(() => expect(client.saveListingPreferences).toHaveBeenCalledWith(expect.objectContaining({
      shopListingConfigs: expect.arrayContaining([
        expect.objectContaining({ externalShopId: "shop-a", productTemplateId: "cloud-template-a-new" }),
      ]),
    })));
    const savedPreferences = vi.mocked(client.saveListingPreferences).mock.calls.at(-1)![0];
    expect(savedPreferences.selectedMockupTemplate).toBe(otherMockupTemplate.id);
    expect(savedPreferences.shopListingConfigs?.map((config) => config.externalShopId)).toEqual(["shop-a", "shop-c"]);
  });

  it("restores the exact multi-shop snapshot previously saved through the UI", async () => {
    const client = createClient(baseAsset);
    const cloudTemplates: CloudProductTemplate[] = ["a", "b"].map((suffix) => ({
      id: `cloud-template-${suffix}`,
      externalShopId: `shop-${suffix}`,
      shopName: `Shop ${suffix.toUpperCase()}`,
      shared: false,
      name: `Cloud template ${suffix.toUpperCase()}`,
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    }));
    const localTemplates = ["a", "b"].map((suffix) => ({
      id: `local-template-${suffix}`,
      kind: "product_import",
      name: `Local template ${suffix.toUpperCase()}`,
      payload: {},
      createdAt: "2026-07-27T00:00:00.000Z",
      updatedAt: "2026-07-27T00:00:00.000Z",
    }));
    vi.mocked(client.listProductTemplates).mockResolvedValue({ ok: true, templates: cloudTemplates });
    vi.mocked(api.listTemplates).mockResolvedValue(localTemplates);
    vi.mocked(client.getListingPreferences).mockResolvedValue({ ok: true, updatedAt: null, preferences: {} });
    vi.mocked(client.saveListingPreferences).mockImplementation(async (preferences) => ({
      ok: true,
      preferences,
      updatedAt: "2026-07-27T00:01:00.000Z",
    }));
    const props = {
      mode: "pending" as const,
      client,
      shops: ["a", "b"].map((suffix) => ({
        id: `cloud-shop-${suffix}`,
        externalShopId: `shop-${suffix}`,
        name: `Shop ${suffix.toUpperCase()}`,
      })),
      localShops: [],
      onMessage: vi.fn(),
    };

    const first = render(<GalleryManager {...props} />);
    await waitFor(() => expect(findListingRow(first.container, "shop-b")).toBeTruthy());
    for (const suffix of ["a", "b"]) {
      const selects = findListingRow(first.container, `shop-${suffix}`)!.querySelectorAll<HTMLSelectElement>("select");
      fireEvent.change(selects[1], { target: { value: `cloud-template-${suffix}` } });
      fireEvent.change(selects[2], { target: { value: `local-template-${suffix}` } });
    }
    vi.mocked(client.saveListingPreferences).mockClear();
    const manualSaveButton = Array.from(first.container.querySelectorAll<HTMLButtonElement>("button"))
      .find((button) => button.textContent?.includes("保存上架设置"));
    fireEvent.click(manualSaveButton!);
    await waitFor(() => expect(client.saveListingPreferences).toHaveBeenCalled());
    const savedPreferences = vi.mocked(client.saveListingPreferences).mock.calls.at(-1)![0];
    expect(savedPreferences.shopListingConfigs).toEqual(expect.arrayContaining([
      expect.objectContaining({ externalShopId: "shop-a", productTemplateId: "cloud-template-a", localTemplateId: "local-template-a" }),
      expect.objectContaining({ externalShopId: "shop-b", productTemplateId: "cloud-template-b", localTemplateId: "local-template-b" }),
    ]));
    first.unmount();

    vi.mocked(client.getListingPreferences).mockResolvedValue({
      ok: true,
      updatedAt: "2026-07-27T00:01:00.000Z",
      preferences: savedPreferences,
    });
    const second = render(<GalleryManager {...props} />);
    await waitFor(() => {
      for (const suffix of ["a", "b"]) {
        const values = Array.from(findListingRow(second.container, `shop-${suffix}`)!.querySelectorAll("select")).map((select) => select.value);
        expect(values).toEqual(expect.arrayContaining([`cloud-template-${suffix}`, `local-template-${suffix}`]));
      }
    });
  });
});
