import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CloudAutoListingPlan,
  CloudMockupTemplate,
  CloudProductImageRule,
  CloudTitlePromptTemplate,
  Shop,
  TemplateSummary,
} from '@shared/types';
import { defaultSettings } from '../../lib/api';
import type {
  CloudListingPreferences,
  CloudProductTemplate,
  CloudShop,
  SaveAutoListingPlanInput,
} from '../../lib/cloudApi';
import { AutoListingPlansPage } from './AutoListingPlansPage';
import { validateAutoListingPlanDraft, type AutoListingPlanDraft } from './autoListingUtils';

afterEach(() => cleanup());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const productRule: CloudProductImageRule = {
  id: 'rule-scarf',
  productType: '丝巾',
  aspectRatio: '1:1',
  ratioWidth: 1,
  ratioHeight: 1,
  enabled: true,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

const mockupTemplate: CloudMockupTemplate = {
  id: 'mockup-square',
  name: '方巾样机',
  sceneCount: 6,
  outputWidth: 800,
  outputHeight: 800,
};

const promptTemplate: CloudTitlePromptTemplate = {
  id: 'prompt-scarf',
  name: '丝巾标题提示词',
  prompt: '根据图片生成丝巾标题',
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

const localShop: Shop = {
  id: 'local-shop-a',
  name: '店铺 A',
  clientId: 'client-a',
  apiKeyStored: true,
  ossAccessKeyStored: true,
  ozonSellerCookieStored: false,
  enabled: true,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

const cloudShop: CloudShop = { id: 'cloud-shop-a', externalShopId: 'local-shop-a', name: '店铺 A' };

const productTemplate: CloudProductTemplate = {
  id: 'product-template-a',
  externalShopId: 'local-shop-a',
  shopName: '店铺 A',
  name: '店铺 A 商品模板',
  payload: { category_id: 1 },
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

const localProductTemplate: TemplateSummary = {
  id: 'local-template-a',
  kind: 'product_import',
  name: '店铺 A 本地模板',
  payload: { category_id: 1, warehouse_id: 10 },
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

const savedPreferences: CloudListingPreferences = {
  productImageRuleId: productRule.id,
  selectedMockupTemplate: mockupTemplate.id,
  selectedTitlePromptId: promptTemplate.id,
  titlePromptName: promptTemplate.name,
  titlePrompt: promptTemplate.prompt,
  shopListingConfigs: [{
    externalShopId: 'local-shop-a',
    productTemplateId: productTemplate.id,
    productTemplateName: productTemplate.name,
    localTemplateId: localProductTemplate.id,
    autoGenerateBarcode: true,
    autoUpdateStock: true,
  }],
};

type DependencyOptions = {
  preferences?: CloudListingPreferences;
  plans?: CloudAutoListingPlan[];
  productTemplates?: CloudProductTemplate[];
  localTemplates?: TemplateSummary[];
  cloudShops?: CloudShop[];
  warehouses?: Array<{ warehouseId: number; name: string }>;
  warehouseError?: Error;
  saveError?: Error;
  schedulerError?: string;
};

function createDependencies(options: DependencyOptions = {}) {
  const preferences = options.preferences ?? savedPreferences;
  let plans: CloudAutoListingPlan[] = [...(options.plans ?? [])];
  const client = {
    listAutoListingPlans: vi.fn(async () => ({ ok: true, plans })),
    saveAutoListingPlan: vi.fn(async (draft: SaveAutoListingPlanInput) => {
      if (options.saveError) throw options.saveError;
      const saved: CloudAutoListingPlan = {
        ...draft,
        id: draft.id ?? 'plan-1',
        createdAt: '2026-07-28T00:00:00.000Z',
        updatedAt: '2026-07-28T00:00:00.000Z',
      };
      plans = [...plans.filter((plan) => plan.id !== saved.id), saved];
      return { ok: true, plan: saved };
    }),
    listProductImageRules: vi.fn(async () => ({ ok: true, rules: [productRule] })),
    listMockupTemplates: vi.fn(async () => ({ ok: true, templates: [mockupTemplate] })),
    listTitlePromptTemplates: vi.fn(async () => ({ ok: true, templates: [promptTemplate] })),
    listShops: vi.fn(async () => ({ ok: true, shops: options.cloudShops ?? [cloudShop] })),
    listProductTemplates: vi.fn(async () => ({ ok: true, templates: options.productTemplates ?? [productTemplate] })),
    getListingPreferences: vi.fn(async () => ({ ok: true, preferences, updatedAt: '2026-07-28T00:00:00.000Z' })),
  };
  const localApi = {
    listTemplates: vi.fn(async () => options.localTemplates ?? [localProductTemplate]),
    listWarehouses: vi.fn(async () => {
      if (options.warehouseError) throw options.warehouseError;
      return options.warehouses ?? [{ warehouseId: 10, name: '主仓' }];
    }),
    runAutoListingPlanNow: vi.fn(async () => ({
      accountId: 'account-a',
      tickRunning: false,
      planStates: options.schedulerError ? [{
        planId: savedPlan.id,
        paused: false,
        lastError: options.schedulerError,
      }] : [],
    })),
  };
  return { client, localApi };
}

const savedPlan: CloudAutoListingPlan = {
  id: 'plan-1',
  name: '丝巾自动上品',
  productImageRuleId: productRule.id,
  mockupTemplateId: mockupTemplate.id,
  mockupTemplateName: mockupTemplate.name,
  titlePromptTemplateId: promptTemplate.id,
  titlePromptTemplateName: promptTemplate.name,
  titlePrompt: promptTemplate.prompt,
  shopConfigs: [{
    externalShopId: 'local-shop-a',
    shopName: '店铺 A',
    localShopId: localShop.id,
    localTemplateId: localProductTemplate.id,
    productTemplateId: productTemplate.id,
    productTemplateName: productTemplate.name,
    templateProduct: localProductTemplate.payload,
    autoGenerateBarcode: true,
    autoUpdateStock: true,
    autoAddToAction: false,
  }],
  startMinute: 8 * 60,
  endMinute: 22 * 60,
  batchSize: 10,
  bufferSize: 20,
  enabled: true,
  createdAt: '2026-07-28T00:00:00.000Z',
  updatedAt: '2026-07-28T00:00:00.000Z',
};

async function openReview() {
  fireEvent.click(await screen.findByRole('button', { name: '新建方案' }));
  fireEvent.change(await screen.findByLabelText('方案名称'), { target: { value: '回归测试方案' } });
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '下一步' }));
}

describe('AutoListingPlansPage', () => {
  it('renders plans before background warehouse loading finishes', async () => {
    const warehouseRequest = deferred<Array<{ warehouseId: number; name: string }>>();
    const { client, localApi } = createDependencies({ plans: [savedPlan] });
    localApi.listWarehouses.mockReturnValue(warehouseRequest.promise);

    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    expect(await screen.findByText('丝巾自动上品')).toBeTruthy();
    expect((screen.getByRole('button', { name: '新建方案' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText('正在后台加载 1 家店铺的仓库资料…')).toBeTruthy();

    warehouseRequest.resolve([{ warehouseId: 10, name: '主仓' }]);

    await waitFor(() => expect(screen.queryByText('正在后台加载 1 家店铺的仓库资料…')).toBeNull());
  });
  it('runs one selected plan immediately and opens upload progress', async () => {
    const { client, localApi } = createDependencies({ plans: [savedPlan] });
    const onNavigate = vi.fn();
    render(
      <AutoListingPlansPage
        settings={defaultSettings}
        shops={[localShop]}
        client={client}
        localApi={localApi}
        accountId='account-a'
        cloudAuthToken='token-a'
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '立即执行丝巾自动上品一次' }));

    await waitFor(() => expect(localApi.runAutoListingPlanNow).toHaveBeenCalledWith({
      accountId: 'account-a',
      cloudApiBaseUrl: defaultSettings.cloudApiBaseUrl,
      cloudAuthToken: 'token-a',
      planId: savedPlan.id,
      force: true,
    }));
    expect(onNavigate).toHaveBeenCalledWith('imageProcessing');
  });

  it('shows the local scheduler error instead of a misleading upload-progress message', async () => {
    const { client, localApi } = createDependencies({
      plans: [savedPlan],
      schedulerError: 'Progress update failed',
    });
    const onNavigate = vi.fn();
    render(
      <AutoListingPlansPage
        settings={defaultSettings}
        shops={[localShop]}
        client={client}
        localApi={localApi}
        accountId='account-a'
        cloudAuthToken='token-a'
        onNavigate={onNavigate}
      />,
    );

    await screen.findByText(savedPlan.name);
    const runButton = screen.getAllByRole('button')
      .find((button) => button.textContent?.includes('\u4e00\u6b21'));
    expect(runButton).toBeTruthy();
    fireEvent.click(runButton!);

    expect(await screen.findByText(/Progress update failed/)).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('opens upload progress without starting the plan', async () => {
    const { client, localApi } = createDependencies({ plans: [savedPlan] });
    const onNavigate = vi.fn();
    render(
      <AutoListingPlansPage
        settings={defaultSettings}
        shops={[localShop]}
        client={client}
        localApi={localApi}
        onNavigate={onNavigate}
      />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '查看丝巾自动上品进度' }));

    expect(onNavigate).toHaveBeenCalledWith('imageProcessing');
    expect(localApi.runAutoListingPlanNow).not.toHaveBeenCalled();
  });

  it('moves through four steps and shows the saved plan summary', async () => {
    const { client, localApi } = createDependencies();
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '新建方案' }));
    expect(screen.getByText('第 1 步 / 共 4 步')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('方案名称'), { target: { value: '丝巾自动上品' } });
    fireEvent.change(screen.getByLabelText('商品类型'), { target: { value: productRule.id } });
    fireEvent.change(screen.getByLabelText('样机模板'), { target: { value: mockupTemplate.id } });
    fireEvent.change(screen.getByLabelText('标题提示词模板'), { target: { value: promptTemplate.id } });

    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('第 2 步 / 共 4 步')).toBeTruthy();
    expect((screen.getByLabelText('选择店铺 A') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('店铺 A 商品模板') as HTMLSelectElement).value).toBe(productTemplate.id);

    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('第 3 步 / 共 4 步')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByText('第 4 步 / 共 4 步')).toBeTruthy();
    expect(screen.getByText('08:00–22:00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '保存方案' }));

    await waitFor(() => expect(client.saveAutoListingPlan).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('丝巾自动上品')).toBeTruthy();
    expect(screen.getByText('商品类型：丝巾')).toBeTruthy();
    expect(screen.getByText('样机：方巾样机')).toBeTruthy();
    expect(screen.getByText('标题提示词：丝巾标题提示词')).toBeTruthy();
    expect(screen.getByText('店铺：店铺 A')).toBeTruthy();
    expect(screen.getByText('执行时段：08:00–22:00')).toBeTruthy();
  });

  it('uses throughput-friendly defaults for a new plan', async () => {
    const { client, localApi } = createDependencies();
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '新建方案' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    expect((screen.getByLabelText('单批数量') as HTMLInputElement).value).toBe('20');
    expect((screen.getByLabelText('滚动缓冲') as HTMLInputElement).value).toBe('10');
  });

  it('only shows shops bound to the current user when creating a plan', async () => {
    const staleCloudShop: CloudShop = { id: 'cloud-shop-stale', externalShopId: 'deleted-shop', name: '旧店铺' };
    const stalePreferences: CloudListingPreferences = {
      ...savedPreferences,
      shopListingConfigs: [
        ...(savedPreferences.shopListingConfigs ?? []),
        {
          externalShopId: 'deleted-shop',
          productTemplateId: '',
          productTemplateName: '',
          localTemplateId: '',
          autoGenerateBarcode: true,
          autoUpdateStock: true,
        },
      ],
    };
    const { client, localApi } = createDependencies({
      cloudShops: [cloudShop, staleCloudShop],
      preferences: stalePreferences,
    });
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '新建方案' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    expect(screen.getByLabelText('选择店铺 A')).toBeTruthy();
    expect(screen.queryByText('旧店铺')).toBeNull();
    expect(screen.queryByLabelText('选择旧店铺')).toBeNull();
  });

  it('blocks saving when a selected shop has no product template', async () => {
    const { client, localApi } = createDependencies({ preferences: {} });
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '新建方案' }));
    fireEvent.change(screen.getByLabelText('方案名称'), { target: { value: '缺模板方案' } });
    fireEvent.change(screen.getByLabelText('商品类型'), { target: { value: productRule.id } });
    fireEvent.change(screen.getByLabelText('样机模板'), { target: { value: mockupTemplate.id } });
    fireEvent.change(screen.getByLabelText('标题提示词模板'), { target: { value: promptTemplate.id } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByLabelText('选择店铺 A'));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '保存方案' }));

    expect(await screen.findByText('店铺 A 缺少商品模板')).toBeTruthy();
    expect(client.saveAutoListingPlan).not.toHaveBeenCalled();
  });

  it('edits an existing plan and saves it with the existing id', async () => {
    const { client, localApi } = createDependencies({ plans: [savedPlan] });
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    fireEvent.click(await screen.findByRole('button', { name: '编辑丝巾自动上品' }));
    expect((screen.getByLabelText('方案名称') as HTMLInputElement).value).toBe('丝巾自动上品');
    fireEvent.change(screen.getByLabelText('方案名称'), { target: { value: '丝巾自动上品（已编辑）' } });
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    expect((screen.getByLabelText('店铺 A 商品模板') as HTMLSelectElement).value).toBe(productTemplate.id);
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    fireEvent.click(screen.getByRole('button', { name: '保存方案' }));

    await waitFor(() => expect(client.saveAutoListingPlan).toHaveBeenCalledWith(expect.objectContaining({
      id: savedPlan.id,
      name: '丝巾自动上品（已编辑）',
    })));
    expect(await screen.findByText('丝巾自动上品（已编辑）')).toBeTruthy();
    expect(screen.queryByText('丝巾自动上品')).toBeNull();
  });

  it('blocks an enabled plan when its saved cloud product template no longer exists', async () => {
    const { client, localApi } = createDependencies({ productTemplates: [] });
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    await openReview();
    fireEvent.click(screen.getByRole('button', { name: '保存方案' }));

    expect(await screen.findByText('店铺 A 商品模板已失效，请重新选择')).toBeTruthy();
    expect(client.saveAutoListingPlan).not.toHaveBeenCalled();
  });

  it('blocks an enabled plan when its saved local template no longer exists', async () => {
    const { client, localApi } = createDependencies({ localTemplates: [] });
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    await openReview();
    fireEvent.click(screen.getByRole('button', { name: '保存方案' }));

    expect(await screen.findByText('店铺 A 本地执行模板已失效，请重新选择')).toBeTruthy();
    expect(client.saveAutoListingPlan).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...localShop, clientId: '' }, '店铺 A 缺少 Ozon Client ID'],
    [{ ...localShop, apiKeyStored: false }, '店铺 A 缺少 Ozon API Key'],
    [{ ...localShop, enabled: false }, '店铺 A 已停用'],
  ])('blocks an enabled plan with an invalid local shop', async (shop, expectedMessage) => {
    const { client, localApi } = createDependencies();
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[shop]} client={client} localApi={localApi} />,
    );

    await openReview();
    fireEvent.click(screen.getByRole('button', { name: '保存方案' }));

    expect(await screen.findByText(expectedMessage)).toBeTruthy();
    expect(client.saveAutoListingPlan).not.toHaveBeenCalled();
  });

  it('blocks an enabled stock-updating plan when its local template has no warehouse', async () => {
    const templateWithoutWarehouse = { ...localProductTemplate, payload: { category_id: 1 } };
    const { client, localApi } = createDependencies({ localTemplates: [templateWithoutWarehouse] });
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    await openReview();
    fireEvent.click(screen.getByRole('button', { name: '保存方案' }));

    expect(await screen.findByText('店铺 A 本地执行模板未配置仓库')).toBeTruthy();
    expect(client.saveAutoListingPlan).not.toHaveBeenCalled();
  });

  it('blocks an enabled stock-updating plan when warehouses fail to load', async () => {
    const { client, localApi } = createDependencies({ warehouseError: new Error('local helper unavailable') });
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    await openReview();
    fireEvent.click(screen.getByRole('button', { name: '保存方案' }));

    expect(await screen.findByText('店铺 A 仓库加载失败，请检查本地助手连接')).toBeTruthy();
    expect(client.saveAutoListingPlan).not.toHaveBeenCalled();
  });

  it('shows a clear Chinese message for cloud plan conflicts', async () => {
    const { client, localApi } = createDependencies({
      saveError: new Error('An enabled plan already exists for this product rule'),
    });
    render(
      <AutoListingPlansPage settings={defaultSettings} shops={[localShop]} client={client} localApi={localApi} />,
    );

    await openReview();
    fireEvent.click(screen.getByRole('button', { name: '保存方案' }));

    expect(await screen.findByText('该商品类型已有启用方案，请先编辑或停用原方案')).toBeTruthy();
    expect(screen.queryByText('An enabled plan already exists for this product rule')).toBeNull();
  });
});

describe('validateAutoListingPlanDraft', () => {
  const validDraft: AutoListingPlanDraft = {
    name: '丝巾自动上品',
    productImageRuleId: productRule.id,
    mockupTemplateId: mockupTemplate.id,
    mockupTemplateName: mockupTemplate.name,
    titlePromptTemplateId: promptTemplate.id,
    titlePromptTemplateName: promptTemplate.name,
    titlePrompt: promptTemplate.prompt,
    shopConfigs: [{
      externalShopId: 'local-shop-a',
      shopName: '店铺 A',
      localShopId: 'local-shop-a',
      localTemplateId: localProductTemplate.id,
      productTemplateId: productTemplate.id,
      productTemplateName: productTemplate.name,
      templateProduct: localProductTemplate.payload,
      autoGenerateBarcode: true,
      autoUpdateStock: true,
      autoAddToAction: false,
    }],
    startMinute: 8 * 60,
    endMinute: 22 * 60,
    batchSize: 10,
    bufferSize: 20,
    enabled: true,
  };

  it.each([
    [4, '单批数量必须在 5–20 之间'],
    [21, '单批数量必须在 5–20 之间'],
  ])('rejects batch size %i', (batchSize, expectedMessage) => {
    expect(validateAutoListingPlanDraft({ ...validDraft, batchSize })).toContain(expectedMessage);
  });

  it('accepts both batch size boundaries', () => {
    expect(validateAutoListingPlanDraft({ ...validDraft, batchSize: 5, bufferSize: 10 })).toEqual([]);
    expect(validateAutoListingPlanDraft({ ...validDraft, batchSize: 20, bufferSize: 40 })).toEqual([]);
  });

  it('rejects a buffer larger than two batches', () => {
    expect(validateAutoListingPlanDraft({ ...validDraft, batchSize: 5, bufferSize: 11 }))
      .toContain('滚动缓冲不能超过两个批次');
  });

  it('rejects a selected shop without a product template', () => {
    const draft = {
      ...validDraft,
      shopConfigs: [{ ...validDraft.shopConfigs[0], productTemplateId: '', productTemplateName: '' }],
    };
    expect(validateAutoListingPlanDraft(draft)).toContain('店铺 A 缺少商品模板');
  });
});


