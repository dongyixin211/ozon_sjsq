import { useEffect, useMemo, useState } from 'react';
import type {
  AppSettings,
  AutoListingPlanShopConfig,
  CloudAutoListingPlan,
  CloudMockupTemplate,
  CloudProductImageRule,
  CloudTitlePromptTemplate,
  Shop,
  TemplateSummary,
  WarehouseOption,
} from '@shared/types';
import { api } from '../../lib/api';
import {
  createCloudClient,
  type CloudClient,
  type CloudListingPreferences,
  type CloudProductTemplate,
  type CloudShop,
} from '../../lib/cloudApi';
import { buildInitialListingSetup, type ShopListingConfig } from './listingSetupUtils';
import {
  autoListingErrorMessage,
  formatMinuteOfDay,
  getTemplateWarehouseId,
  parseMinuteOfDay,
  validateAutoListingPlanDraft,
  type AutoListingPlanDraft,
} from './autoListingUtils';

const PRODUCT_TEMPLATE_KIND = 'product_import';

type AutoListingPlansClient = Pick<
  CloudClient,
  | 'listProductImageRules'
  | 'listMockupTemplates'
  | 'listTitlePromptTemplates'
  | 'listShops'
  | 'listProductTemplates'
  | 'getListingPreferences'
  | 'listAutoListingPlans'
  | 'saveAutoListingPlan'
>;

type LocalListingApi = Pick<typeof api, 'listTemplates' | 'listWarehouses' | 'runAutoListingPlanNow'>;

type Props = {
  settings: AppSettings;
  shops: Shop[];
  client?: AutoListingPlansClient;
  localApi?: LocalListingApi;
  accountId?: string;
  cloudAuthToken?: string;
  onNavigate?: (page: 'imageProcessing') => void;
  onMessage?: (message: string) => void;
};

type LoadedResources = {
  plans: CloudAutoListingPlan[];
  productRules: CloudProductImageRule[];
  mockupTemplates: CloudMockupTemplate[];
  promptTemplates: CloudTitlePromptTemplate[];
  cloudShops: CloudShop[];
  productTemplates: CloudProductTemplate[];
  localTemplates: TemplateSummary[];
  preferences: CloudListingPreferences;
  listingConfigs: ShopListingConfig[];
  warehousesByShopId: Record<string, WarehouseOption[]>;
  warehouseLoadFailedShopIds: string[];
};

const emptyResources: LoadedResources = {
  plans: [],
  productRules: [],
  mockupTemplates: [],
  promptTemplates: [],
  cloudShops: [],
  productTemplates: [],
  localTemplates: [],
  preferences: {},
  listingConfigs: [],
  warehousesByShopId: {},
  warehouseLoadFailedShopIds: [],
};

export function AutoListingPlansPage(props: Props) {
  const client = useMemo(
    () => props.client ?? createCloudClient(props.settings.cloudApiBaseUrl) as AutoListingPlansClient,
    [props.client, props.settings.cloudApiBaseUrl],
  );
  const localApi = props.localApi ?? api;
  const [resources, setResources] = useState<LoadedResources>(emptyResources);
  const [loading, setLoading] = useState(true);
  const [loadingWarehouseShopIds, setLoadingWarehouseShopIds] = useState<string[]>([]);
  const [loadError, setLoadError] = useState('');
  const [draft, setDraft] = useState<AutoListingPlanDraft | null>(null);
  const [step, setStep] = useState(1);
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [runningPlanId, setRunningPlanId] = useState('');
  const [runMessage, setRunMessage] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadingWarehouseShopIds([]);
    Promise.all([
      client.listAutoListingPlans(),
      client.listProductImageRules(),
      client.listMockupTemplates(),
      client.listTitlePromptTemplates(),
      client.listShops(),
      client.listProductTemplates(),
      client.getListingPreferences(),
      localApi.listTemplates(PRODUCT_TEMPLATE_KIND),
    ]).then(([plans, rules, mockups, prompts, cloudShops, productTemplates, preferences, localTemplates]) => {
      const listingSetup = buildInitialListingSetup({
        cloudShops: cloudShops.shops,
        localShops: props.shops,
        preferences: preferences.preferences,
        currentShopListingConfigs: [],
        productTemplates: productTemplates.templates,
        localProductTemplates: localTemplates,
      });
      const localShopIds = new Set(props.shops.map((shop) => shop.id));
      const userListingConfigs = listingSetup.shopListingConfigs.filter((config) => localShopIds.has(config.externalShopId));
      if (cancelled) return;
      setResources({
        plans: plans.plans,
        productRules: rules.rules.filter((rule) => rule.enabled),
        mockupTemplates: mockups.templates,
        promptTemplates: prompts.templates,
        cloudShops: cloudShops.shops,
        productTemplates: productTemplates.templates,
        localTemplates,
        preferences: preferences.preferences,
        listingConfigs: userListingConfigs,
        warehousesByShopId: {},
        warehouseLoadFailedShopIds: [],
      });
      setLoadError('');
      setLoading(false);
      setLoadingWarehouseShopIds(props.shops.map((shop) => shop.id));
      props.shops.forEach((shop) => {
        localApi.listWarehouses(shop.id).then((warehouses) => {
          if (cancelled) return;
          setResources((current) => ({
            ...current,
            warehousesByShopId: { ...current.warehousesByShopId, [shop.id]: warehouses },
            warehouseLoadFailedShopIds: current.warehouseLoadFailedShopIds.filter((shopId) => shopId !== shop.id),
          }));
        }).catch(() => {
          if (cancelled) return;
          setResources((current) => ({
            ...current,
            warehousesByShopId: { ...current.warehousesByShopId, [shop.id]: [] as WarehouseOption[] },
            warehouseLoadFailedShopIds: Array.from(new Set([...current.warehouseLoadFailedShopIds, shop.id])),
          }));
        }).finally(() => {
          if (!cancelled) {
            setLoadingWarehouseShopIds((current) => current.filter((shopId) => shopId !== shop.id));
          }
        });
      });
    }).catch((error) => {
      if (!cancelled) {
        setLoadError(autoListingErrorMessage(error));
        setLoading(false);
        setLoadingWarehouseShopIds([]);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [client, localApi, props.shops]);

  const startNewPlan = () => {
    setDraft(createInitialDraft(resources, props.shops));
    setStep(1);
    setErrors([]);
  };

  const startEditPlan = (plan: CloudAutoListingPlan) => {
    setDraft(createEditDraft(plan, resources));
    setStep(1);
    setErrors([]);
  };

  const savePlan = async () => {
    if (!draft) return;
    const loadingShopNames = draft.shopConfigs
      .filter((shop) => shop.autoUpdateStock && loadingWarehouseShopIds.includes(shop.localShopId))
      .map((shop) => shop.shopName);
    if (loadingShopNames.length > 0) {
      setErrors([`店铺仓库资料仍在加载：${loadingShopNames.join('、')}。请稍后再保存。`]);
      return;
    }
    const nextErrors = validateAutoListingPlanDraft(draft, {
      productTemplates: resources.productTemplates,
      localTemplates: resources.localTemplates,
      localShops: props.shops,
      warehousesByShopId: resources.warehousesByShopId,
      warehouseLoadFailedShopIds: resources.warehouseLoadFailedShopIds,
    });
    setErrors(nextErrors);
    if (nextErrors.length > 0) return;
    setSaving(true);
    try {
      const result = await client.saveAutoListingPlan(draft);
      setResources((current) => ({
        ...current,
        plans: [...current.plans.filter((plan) => plan.id !== result.plan.id), result.plan],
      }));
      setDraft(null);
    } catch (error) {
      setErrors([autoListingErrorMessage(error)]);
    } finally {
      setSaving(false);
    }
  };

  const runPlanNow = async (plan: CloudAutoListingPlan) => {
    if (!props.accountId || !props.cloudAuthToken) {
      const message = '云端登录状态无效，请重新登录后再执行';
      setRunMessage(message);
      props.onMessage?.(message);
      return;
    }
    setRunningPlanId(plan.id);
    setRunMessage('');
    try {
      const schedulerStatus = await localApi.runAutoListingPlanNow({
        accountId: props.accountId,
        cloudApiBaseUrl: props.settings.cloudApiBaseUrl,
        cloudAuthToken: props.cloudAuthToken,
        planId: plan.id,
        force: true,
      });
      const schedulerError = schedulerStatus.planStates.find((state) => state.planId === plan.id)?.lastError;
      if (schedulerError) {
        const message = '启动后调度异常：' + schedulerError;
        setRunMessage(message);
        props.onMessage?.(message);
        return;
      }
      const message = '已启动“' + plan.name + '”，正在进入上传进度';
      setRunMessage(message);
      props.onMessage?.(message);
      props.onNavigate?.('imageProcessing');
    } catch (error) {
      const message = autoListingErrorMessage(error);
      setRunMessage(message);
      props.onMessage?.(message);
    } finally {
      setRunningPlanId('');
    }
  };

  return (
    <section className='panel'>
      <div className='page-header'>
        <div>
          <span className='eyebrow'>自动上品</span>
          <h2>自动上品方案</h2>
          <p className='muted'>按商品类型保存样机、标题提示词、店铺模板和执行时段。</p>
        </div>
        <button className='primary-button' onClick={startNewPlan} disabled={loading}>新建方案</button>
      </div>

      {loading ? <p className='muted'>正在加载方案配置…</p> : null}
      {!loading && loadingWarehouseShopIds.length > 0 ? <p className='muted'>正在后台加载 {loadingWarehouseShopIds.length} 家店铺的仓库资料…</p> : null}
      {loadError ? <div className='alert'>{loadError}</div> : null}
      {runMessage ? <div className='alert'>{runMessage}</div> : null}
      {!loading && !draft ? (
        <PlanList
          plans={resources.plans}
          productRules={resources.productRules}
          runningPlanId={runningPlanId}
          onEdit={startEditPlan}
          onRun={runPlanNow}
          onViewProgress={() => props.onNavigate?.('imageProcessing')}
        />
      ) : null}
      {draft ? (
        <PlanWizard
          draft={draft}
          step={step}
          resources={resources}
          localShops={props.shops}
          loadingWarehouseShopIds={loadingWarehouseShopIds}
          errors={errors}
          saving={saving}
          onDraftChange={setDraft}
          onStepChange={setStep}
          onCancel={() => setDraft(null)}
          onSave={savePlan}
        />
      ) : null}
    </section>
  );
}

function PlanWizard(props: {
  draft: AutoListingPlanDraft;
  step: number;
  resources: LoadedResources;
  localShops: Shop[];
  loadingWarehouseShopIds: string[];
  errors: string[];
  saving: boolean;
  onDraftChange: (draft: AutoListingPlanDraft) => void;
  onStepChange: (step: number) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const { draft, resources } = props;
  const update = (partial: Partial<AutoListingPlanDraft>) => props.onDraftChange({ ...draft, ...partial });
  const selectedPrompt = resources.promptTemplates.find((template) => template.id === draft.titlePromptTemplateId);

  return (
    <div>
      <div className='status-row'>
        <strong>第 {props.step} 步 / 共 4 步</strong>
        <span className='muted'>{['商品类型与内容模板', '目标店铺与商品模板', '调度设置', '配置检查'][props.step - 1]}</span>
      </div>

      {props.step === 1 ? (
        <div className='form-grid'>
          <label className='field'>
            <span>方案名称</span>
            <input value={draft.name} onChange={(event) => update({ name: event.target.value })} />
          </label>
          <label className='field'>
            <span>商品类型</span>
            <select value={draft.productImageRuleId} onChange={(event) => update({ productImageRuleId: event.target.value })}>
              <option value=''>请选择</option>
              {resources.productRules.map((rule) => <option key={rule.id} value={rule.id}>{rule.productType}</option>)}
            </select>
          </label>
          <label className='field'>
            <span>样机模板</span>
            <select value={draft.mockupTemplateId} onChange={(event) => {
              const template = resources.mockupTemplates.find((item) => item.id === event.target.value);
              update({ mockupTemplateId: event.target.value, mockupTemplateName: template?.name ?? '' });
            }}>
              <option value=''>请选择</option>
              {resources.mockupTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
          </label>
          <label className='field'>
            <span>标题提示词模板</span>
            <select value={draft.titlePromptTemplateId ?? ''} onChange={(event) => {
              const template = resources.promptTemplates.find((item) => item.id === event.target.value);
              update({
                titlePromptTemplateId: event.target.value || null,
                titlePromptTemplateName: template?.name ?? null,
                titlePrompt: template?.prompt ?? '',
              });
            }}>
              <option value=''>请选择</option>
              {resources.promptTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
            </select>
          </label>
          <label className='field' style={{ gridColumn: '1 / -1' }}>
            <span>标题提示词</span>
            <textarea value={draft.titlePrompt} onChange={(event) => update({ titlePrompt: event.target.value })} />
            {selectedPrompt ? <small className='muted'>已载入：{selectedPrompt.name}</small> : null}
          </label>
        </div>
      ) : null}

      {props.step === 2 ? (
        <div>
          {resources.listingConfigs.map((config) => {
            const shopName = shopNameForExternalId(config.externalShopId, props.localShops, resources.cloudShops);
            const selected = draft.shopConfigs.some((shop) => shop.externalShopId === config.externalShopId);
            const selectedConfig = draft.shopConfigs.find((shop) => shop.externalShopId === config.externalShopId);
            const cloudTemplates = resources.productTemplates.filter((template) => (
              template.shared || template.externalShopId === config.externalShopId
            ));
            return (
              <div className='panel' key={config.externalShopId}>
                <label>
                  <input
                    type='checkbox'
                    aria-label={'选择' + shopName}
                    checked={selected}
                    onChange={() => props.onDraftChange({
                      ...draft,
                      shopConfigs: selected
                        ? draft.shopConfigs.filter((shop) => shop.externalShopId !== config.externalShopId)
                        : [...draft.shopConfigs, toPlanShopConfig(config, props.localShops, resources.localTemplates, resources.cloudShops)],
                    })}
                  />
                  {shopName}
                </label>
                {selected && selectedConfig ? (
                  <div className='form-grid'>
                    <label className='field'>
                      <span>商品模板</span>
                      <select
                        aria-label={shopName + ' 商品模板'}
                        value={selectedConfig.productTemplateId}
                        onChange={(event) => {
                          const template = resources.productTemplates.find((item) => item.id === event.target.value);
                          updateShopConfig(props, config.externalShopId, {
                            productTemplateId: event.target.value,
                            productTemplateName: template?.name ?? '',
                          });
                        }}
                      >
                        <option value=''>请选择</option>
                        {cloudTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                      </select>
                    </label>
                    <label className='field'>
                      <span>本地执行模板</span>
                      <select
                        aria-label={shopName + ' 本地执行模板'}
                        value={selectedConfig.localTemplateId}
                        onChange={(event) => {
                          const template = resources.localTemplates.find((item) => item.id === event.target.value);
                          updateShopConfig(props, config.externalShopId, {
                            localTemplateId: event.target.value,
                            templateProduct: template?.payload ?? {},
                          });
                        }}
                      >
                        <option value=''>请选择</option>
                        {resources.localTemplates.map((template) => <option key={template.id} value={template.id}>{template.name}</option>)}
                      </select>
                    </label>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {props.step === 3 ? (
        <div className='form-grid'>
          <label className='field'>
            <span>开始时间</span>
            <input type='time' value={formatMinuteOfDay(draft.startMinute)} onChange={(event) => update({ startMinute: parseMinuteOfDay(event.target.value) })} />
          </label>
          <label className='field'>
            <span>结束时间</span>
            <input type='time' value={formatMinuteOfDay(draft.endMinute)} onChange={(event) => update({ endMinute: parseMinuteOfDay(event.target.value) })} />
          </label>
          <label className='field'>
            <span>单批数量</span>
            <input type='number' min={5} max={20} value={draft.batchSize} onChange={(event) => update({ batchSize: Number(event.target.value) })} />
          </label>
          <label className='field'>
            <span>滚动缓冲</span>
            <input type='number' min={0} max={draft.batchSize * 2} value={draft.bufferSize} onChange={(event) => update({ bufferSize: Number(event.target.value) })} />
          </label>
          <label>
            <input type='checkbox' checked={draft.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
            启用自动执行
          </label>
        </div>
      ) : null}

      {props.step === 4 ? <PlanReview draft={draft} resources={resources} localShops={props.localShops} loadingWarehouseShopIds={props.loadingWarehouseShopIds} /> : null}

      {props.errors.length > 0 ? (
        <div className='alert'>{props.errors.map((error) => <div key={error}>{error}</div>)}</div>
      ) : null}

      <div className='modal-actions'>
        <button className='secondary-button' onClick={props.onCancel}>取消</button>
        {props.step > 1 ? <button className='secondary-button' onClick={() => props.onStepChange(props.step - 1)}>上一步</button> : null}
        {props.step < 4 ? <button className='primary-button' onClick={() => props.onStepChange(props.step + 1)}>下一步</button> : null}
        {props.step === 4 ? <button className='primary-button' disabled={props.saving} onClick={props.onSave}>{props.saving ? '保存中…' : '保存方案'}</button> : null}
      </div>
    </div>
  );
}

function PlanReview({
  draft,
  resources,
  localShops,
  loadingWarehouseShopIds,
}: {
  draft: AutoListingPlanDraft;
  resources: LoadedResources;
  localShops: Shop[];
  loadingWarehouseShopIds: string[];
}) {
  const productType = resources.productRules.find((rule) => rule.id === draft.productImageRuleId)?.productType ?? '未选择';
  return (
    <div>
      <h3>配置摘要</h3>
      <p>商品类型：{productType}</p>
      <p>样机：{draft.mockupTemplateName || '未选择'}</p>
      <p>标题提示词：{draft.titlePromptTemplateName || '自定义提示词'}</p>
      <p>店铺：{draft.shopConfigs.map((shop) => shop.shopName).join('、') || '未选择'}</p>
      <p>{formatMinuteOfDay(draft.startMinute)}–{formatMinuteOfDay(draft.endMinute)}</p>
      <h3>配置检查</h3>
      {draft.shopConfigs.map((shop) => {
        const productTemplateValid = resources.productTemplates.some((template) => (
          template.id === shop.productTemplateId
          && (template.shared || !template.externalShopId || template.externalShopId === shop.externalShopId)
        ));
        const localTemplate = resources.localTemplates.find((template) => template.id === shop.localTemplateId);
        const localShop = localShops.find((candidate) => candidate.id === shop.localShopId);
        const warehouseId = getTemplateWarehouseId(localTemplate?.payload);
        const warehouses = resources.warehousesByShopId[shop.localShopId] ?? [];
        const warehouseStatus = !shop.autoUpdateStock
          ? '无需仓库'
          : loadingWarehouseShopIds.includes(shop.localShopId)
            ? '仓库加载中'
            : resources.warehouseLoadFailedShopIds.includes(shop.localShopId)
            ? '仓库加载失败'
            : !warehouseId
              ? '模板未配置仓库'
              : warehouses.some((warehouse) => warehouse.warehouseId === warehouseId)
                ? '仓库可用'
                : '模板仓库不可用';
        const shopStatus = !localShop
          ? '店铺配置缺失'
          : !localShop.enabled
            ? '店铺已停用'
            : !localShop.clientId.trim() || !localShop.apiKeyStored
              ? '店铺密钥不完整'
              : '店铺配置可用';
        return (
          <div key={shop.externalShopId} className='status-row'>
            <strong>{shop.shopName}</strong>
            <span>{productTemplateValid ? '商品模板已配置' : shop.productTemplateId ? '商品模板已失效' : '缺少商品模板'}</span>
            <span>{localTemplate ? '本地模板已配置' : shop.localTemplateId ? '本地模板已失效' : '缺少本地模板'}</span>
            <span>{warehouseStatus}</span>
            <span>{shopStatus}</span>
          </div>
        );
      })}
      <p className='muted'>本地助手能力由工作台连接状态统一检查。</p>
    </div>
  );
}

function PlanList({
  plans,
  productRules,
  runningPlanId,
  onEdit,
  onRun,
  onViewProgress,
}: {
  plans: CloudAutoListingPlan[];
  productRules: CloudProductImageRule[];
  runningPlanId: string;
  onEdit: (plan: CloudAutoListingPlan) => void;
  onRun: (plan: CloudAutoListingPlan) => void;
  onViewProgress: () => void;
}) {
  if (plans.length === 0) return <p className='muted'>暂无自动上品方案。</p>;
  return (
    <div className='card-grid'>
      {plans.map((plan) => {
        const productType = productRules.find((rule) => rule.id === plan.productImageRuleId)?.productType ?? plan.productImageRuleId;
        return (
          <article className='panel' key={plan.id}>
            <div className='status-row'>
              <h3>{plan.name}</h3>
              <span className='status-pill'>{plan.enabled ? '已启用' : '已暂停'}</span>
              <button className='secondary-button' aria-label={`编辑${plan.name}`} onClick={() => onEdit(plan)}>编辑</button>
            </div>
            <p>商品类型：{productType}</p>
            <p>样机：{plan.mockupTemplateName}</p>
            <p>标题提示词：{plan.titlePromptTemplateName || '自定义提示词'}</p>
            <p>店铺：{plan.shopConfigs.map((shop) => shop.shopName).join('、')}</p>
            <p>执行时段：{formatMinuteOfDay(plan.startMinute)}–{formatMinuteOfDay(plan.endMinute)}</p>
            <div className='status-row'>
              <button
                className='primary-button'
                aria-label={`立即执行${plan.name}一次`}
                disabled={!plan.enabled || Boolean(runningPlanId)}
                onClick={() => onRun(plan)}
              >
                {runningPlanId === plan.id ? '启动中…' : '立即执行一次'}
              </button>
              <button
                className='secondary-button'
                aria-label={`查看${plan.name}进度`}
                onClick={onViewProgress}
              >
                查看进度
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function createInitialDraft(resources: LoadedResources, localShops: Shop[]): AutoListingPlanDraft {
  const preferences = resources.preferences;
  const prompt = resources.promptTemplates.find((template) => template.id === preferences.selectedTitlePromptId)
    ?? resources.promptTemplates[0];
  const mockup = resources.mockupTemplates.find((template) => template.id === preferences.selectedMockupTemplate)
    ?? resources.mockupTemplates[0];
  const savedShopIds = new Set((preferences.shopListingConfigs ?? []).map((config) => config.externalShopId));
  const shopConfigs = resources.listingConfigs
    .filter((config) => savedShopIds.has(config.externalShopId))
    .map((config) => toPlanShopConfig(config, localShops, resources.localTemplates, resources.cloudShops));
  return {
    name: '',
    productImageRuleId: preferences.productImageRuleId ?? resources.productRules[0]?.id ?? '',
    mockupTemplateId: mockup?.id ?? '',
    mockupTemplateName: mockup?.name ?? '',
    titlePromptTemplateId: prompt?.id ?? null,
    titlePromptTemplateName: prompt?.name ?? null,
    titlePrompt: preferences.titlePrompt?.trim() || prompt?.prompt || '',
    shopConfigs,
    startMinute: 8 * 60,
    endMinute: 22 * 60,
    batchSize: 20,
    bufferSize: 10,
    enabled: true,
  };
}

function createEditDraft(plan: CloudAutoListingPlan, resources: LoadedResources): AutoListingPlanDraft {
  return {
    id: plan.id,
    name: plan.name,
    productImageRuleId: plan.productImageRuleId,
    mockupTemplateId: plan.mockupTemplateId,
    mockupTemplateName: plan.mockupTemplateName,
    titlePromptTemplateId: plan.titlePromptTemplateId,
    titlePromptTemplateName: plan.titlePromptTemplateName,
    titlePrompt: plan.titlePrompt,
    shopConfigs: plan.shopConfigs.map((shop) => ({
      ...shop,
      templateProduct: resources.localTemplates.find((template) => template.id === shop.localTemplateId)?.payload
        ?? shop.templateProduct,
    })),
    startMinute: plan.startMinute,
    endMinute: plan.endMinute,
    batchSize: plan.batchSize,
    bufferSize: plan.bufferSize,
    enabled: plan.enabled,
  };
}

function toPlanShopConfig(
  config: ShopListingConfig,
  localShops: Shop[],
  localTemplates: TemplateSummary[],
  cloudShops: CloudShop[],
): AutoListingPlanShopConfig {
  const localShop = localShops.find((shop) => shop.id === config.externalShopId)
    ?? localShops.find((shop) => shop.name === shopNameForExternalId(config.externalShopId, localShops, cloudShops));
  const localTemplate = localTemplates.find((template) => template.id === config.localTemplateId);
  return {
    externalShopId: config.externalShopId,
    shopName: shopNameForExternalId(config.externalShopId, localShops, cloudShops),
    localShopId: localShop?.id ?? config.externalShopId,
    localTemplateId: config.localTemplateId,
    productTemplateId: config.productTemplateId,
    productTemplateName: config.productTemplateName,
    templateProduct: localTemplate?.payload ?? {},
    autoGenerateBarcode: config.autoGenerateBarcode,
    autoUpdateStock: config.autoUpdateStock,
    autoAddToAction: config.autoAddToAction,
  };
}

function updateShopConfig(
  props: Parameters<typeof PlanWizard>[0],
  externalShopId: string,
  partial: Partial<AutoListingPlanShopConfig>,
) {
  props.onDraftChange({
    ...props.draft,
    shopConfigs: props.draft.shopConfigs.map((shop) => (
      shop.externalShopId === externalShopId ? { ...shop, ...partial } : shop
    )),
  });
}

function shopNameForExternalId(externalShopId: string, localShops: Shop[], cloudShops: CloudShop[]) {
  return localShops.find((shop) => shop.id === externalShopId)?.name
    ?? cloudShops.find((shop) => (shop.externalShopId || shop.external_shop_id || shop.id) === externalShopId)?.name
    ?? '店铺';
}
