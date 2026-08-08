import { AlertCircle, CheckCircle2, Copy, Download, Grid2X2, Images, List, LoaderCircle, PackageCheck, Plus, RefreshCw, Star, Trash2, Upload, Wand2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { InputHTMLAttributes } from "react";
import type { AutoListingRequest, CloudAsset, CloudListingBatch, CloudListingBatchProgressSummary, CloudListingConfigSnapshot, CloudListingReconciliationSummary, CloudListingShopProgress, CloudListingStageProgress, CloudMockupAsset, CloudMockupTemplate, CloudProductImageRule, CloudTitlePromptTemplate, CloudUser, GalleryUploadSelection, JobLog, JobSummary, ListingImageRepairItem, LocalMockupRenderResult, Shop, ShopDailyListingStat, TemplateSummary, WarehouseOption } from "@shared/types";
import { api } from "../../lib/api";
import { cloudAccountId, CloudApiError, getCloudToken, type BatchUploadAssetsResult, type CloudClient, type CloudListingPreferenceShopConfig, type CloudListingPreferences, type CloudProductTemplate, type CloudShop, type CreateListingBatchInput, type GalleryQuery, type GalleryUploadTask } from "../../lib/cloudApi";
import { statusText } from "../../lib/format";
import { renderMockupLocallyAndUpload } from "../../lib/localMockupRenderer";
import { AutoListingTaskCenter, type AutoListingTaskCenterSummary, type AutoListingTaskCenterTask } from "./AutoListingTaskCenter";
import {
  buildInitialListingSetup,
  createDefaultShopListingConfig,
  mergeListingShops,
  type ListingSetupPhase,
  type ShopListingConfig,
} from "./listingSetupUtils";
import { autoListingText, getAutoListingDisabledReason } from "./auto-listing/autoListingText";
import { buildAutoListingSummary } from "./auto-listing/autoListingStats";

interface Props {
  mode: "upload" | "pending" | "processing" | "uploaded" | "featured";
  client: CloudClient;
  shops: CloudShop[];
  localShops?: Shop[];
  cloudApiBaseUrl?: string;
  defaultPageSize?: number;
  onMessage: (message: string) => void;
  onJobStarted?: (job: JobSummary) => void;
  onNavigate?: (page: "jobs" | "ozon" | "imageUpload" | "imageProcessing") => void;
  onCloudShopsChanged?: () => void | Promise<void>;
}

type ViewMode = "grid" | "list";
type GalleryTab = "upload" | "pending" | "processing" | "uploaded" | "featured";
type UploadSource = "files" | "folder";
type MockupStatusFilter = "all" | "not_rendered" | "rendered";
type UploadProgress = {
  currentBatch: number;
  totalBatches: number;
  uploaded: number;
  failed: number;
  totalFiles: number;
  currentBatchFiles?: number;
  currentBatchBytes?: number;
  totalBytes?: number;
};
type UploadError = {
  filename: string;
  message: string;
};
type UploadTaskStatus = "selected" | "running" | "succeeded" | "partial" | "failed";
type UploadTaskSnapshot = {
  id: string;
  source: UploadSource;
  status: UploadTaskStatus;
  totalFiles: number;
  totalBatches: number;
  totalBytes: number;
  uploaded: number;
  failed: number;
  processed: number;
  currentBatch: number;
  currentBatchFiles?: number;
  currentBatchBytes?: number;
  sampleFilenames: string[];
  errors: UploadError[];
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  updatedAt: string;
};
type MockupBatchProgress = {
  total: number;
  done: number;
  failed: number;
  currentSku: string;
};
type MockupNotice = {
  type: "info" | "success" | "error";
  message: string;
};

type ListingAssetDraft = {
  externalShopId: string;
  imageAssetIds: string[];
  title: string;
  titleStatus: "idle" | "generating" | "done" | "error";
  titleError?: string;
};
type ListingProgress = {
  stage: string;
  total: number;
  done: number;
  failed: number;
  currentSku?: string;
};
type ListingQuotaSnapshot = {
  externalShopId: string;
  limit: number;
  listedCount: number;
  reservedCount: number;
  pendingCount: number;
  selectedCount: number;
  remaining: number;
  overBy: number;
};
type RepairImageProgress = {
  phase: "scanning" | "running" | "succeeded" | "failed" | "cancelled";
  message: string;
  scanned?: number;
  total?: number;
  skipped?: number;
  job?: JobSummary;
};
type UploadedRepairTarget = {
  asset: CloudAsset;
  externalShopId: string;
  shopName?: string;
  batchId?: string;
};
type AutoListingPreparationOptions = {
  submitAfterPrepare?: boolean;
  blocking?: boolean;
  allowNonPendingTab?: boolean;
  context?: AutoListingPreparationContext;
  preparationTaskId?: string;
  throwOnError?: boolean;
};
type StartAutoListingOptions = {
  navigate?: boolean;
  loading?: boolean;
  navigateTo?: "jobs" | "imageProcessing";
  silentFailure?: boolean;
  refreshBatch?: boolean;
};
type AutoListingPreparationContext = {
  runId: string;
  ratioFamily: CloudAsset["ratioFamily"];
  productImageRuleId: string;
  productType: string;
  aspectRatio: string;
  mockupTemplateId: string;
  mockupTemplateName: string;
  titlePromptTemplateId: string;
  titlePromptTemplateName: string;
  titlePrompt: string;
  shopListingConfigs: ShopListingConfig[];
  shopConfigSnapshots: CloudListingConfigSnapshot[];
  draftsByAssetId: Record<string, ListingAssetDraft>;
  createdAt: string;
};
type LocalPreparationTask = {
  id: string;
  assetIds: string[];
  status: "queued" | "running" | "prepared" | "failed";
  context: AutoListingPreparationContext;
  localMockupJobId?: string;
  progress?: LocalPreparationProgress;
  error?: string;
  createdAt: number;
  updatedAt: number;
};
type LocalPreparationStage = "queued" | "mockup" | "title" | "batch" | "submit" | "failed";
type LocalPreparationProgress = {
  stage: LocalPreparationStage;
  total: number;
  done: number;
  failed: number;
  percent?: number;
  currentSku?: string;
  message?: string;
  updatedAt: number;
};
type PreparationTaskRun = {
  id: string;
  assets: CloudAsset[];
  context: AutoListingPreparationContext;
  isLegacy?: boolean;
};
type LocalMockupWaitOptions = {
  jobId?: string;
  onJobStarted?: (job: JobSummary) => void;
  onProgress?: (job: JobSummary) => void;
};
type ActionOption = {
  id: number;
  title: string;
  status?: string;
};
type DirectoryInputProps = InputHTMLAttributes<HTMLInputElement> & {
  webkitdirectory?: string;
  directory?: string;
};

const ratioOptions = [
  ["", "全部比例"],
  ["portrait", "3:4"],
  ["square", "1:1"],
  ["landscape", "4:3"],
  ["wide", "16:9"],
];

const pageSizeOptions = [10, 20, 40, 60, 100];
const mockupStatusOptions: Array<[MockupStatusFilter, string]> = [
  ["all", "全部图片"],
  ["not_rendered", "未套当前样机"],
  ["rendered", "已套当前样机"],
];
const maxUploadBatchSize = 20;
const maxUploadBatchBytes = 8 * 1024 * 1024;
const maxUploadBatchLabel = formatFileSize(maxUploadBatchBytes);
const maxUploadRequestBytes = 20 * 1024 * 1024;
const uploadRetryDelays = [1500, 3500, 7000];
const supportedImageTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const supportedImageExtensions = [".png", ".jpg", ".jpeg", ".webp"];
const mockupBatchConcurrency = 4;
const titleBatchConcurrency = 20;
const PRODUCT_TEMPLATE_KIND = "product_import";
const SHARED_PRODUCT_TEMPLATE_SHOP_ID = "__shared__";
const EMPTY_LOCAL_SHOPS: Shop[] = [];
const localProcessingStoragePrefix = "ozon-sjsq:gallery-local-processing:v1:";
const localPreparationTaskStoragePrefix = "ozon-sjsq:gallery-preparation-tasks:v1:";
const uploadTaskStorageKey = "ozon-sjsq:gallery-upload-task:v1";
const uploadTaskHistoryStorageKey = "ozon-sjsq:gallery-upload-history:v1";
const localProcessingRetentionMs = 24 * 60 * 60 * 1000;
const localPreparationTaskRetentionMs = 7 * 24 * 60 * 60 * 1000;
const preparationResumeConcurrency = 1;
const listingPreparationChunkSize = 20;
const autoSubmitBatchConcurrency = 3;
const resumeListingBatchConcurrency = 3;
type StoredLocalProcessingAsset = {
  asset: CloudAsset;
  savedAt: number;
};
const defaultTitlePrompt = "\u8bf7\u6839\u636e\u5546\u54c1\u56fe\u7247\u751f\u6210\u4e00\u4e2a\u9002\u5408 Ozon \u5e73\u53f0\u7684\u5546\u54c1\u6807\u9898\uff0c\u53ea\u8fd4\u56de\u6807\u9898\u3002\u8d27\u53f7\uff1a{sku}";
const fallbackMockupTemplates: CloudMockupTemplate[] = [
  {
    id: "fangjin",
    name: "方巾样机",
    description: "适合 1:1 平面图，生成头巾、方巾、丝巾类商品效果图。",
    productType: "方巾 / 头巾 / 丝巾",
    sourceAspectRatio: "1:1",
    status: "system",
    sceneCount: 6,
    outputWidth: 800,
    outputHeight: 1067,
  },
  {
    id: "zhuobu",
    name: "桌布样机",
    description: "适合 3:2 平面图，生成桌布室内、户外、尺寸和细节场景效果图。",
    productType: "\u684c\u5e03 / \u9910\u684c\u5e03",
    sourceAspectRatio: "3:2",
    status: "system",
    sceneCount: 9,
    outputWidth: 800,
    outputHeight: 1067,
  },
  {
    id: "shukoudai",
    name: "\u675f\u53e3\u888b\u6837\u673a",
    description: "适合 3:4 平面图，生成束口袋多场景商品效果图。",
    productType: "\u675f\u53e3\u888b / \u6536\u7eb3\u888b / \u62bd\u7ef3\u888b",
    sourceAspectRatio: "3:4",
    status: "system",
    sceneCount: 6,
    outputWidth: 1086,
    outputHeight: 1448,
  },
];

export function GalleryManager({ mode, client, shops, localShops = EMPTY_LOCAL_SHOPS, cloudApiBaseUrl, defaultPageSize = 10, onMessage, onJobStarted, onNavigate, onCloudShopsChanged }: Props) {
  const [assets, setAssets] = useState<CloudAsset[]>([]);
  const [total, setTotal] = useState(0);
  const [tab, setTab] = useState<GalleryTab>(mode);
  const [ratioFamily, setRatioFamily] = useState("");
  const [keyword, setKeyword] = useState("");
  const [hideUsed, setHideUsed] = useState(true);
  const [mockupStatus, setMockupStatus] = useState<MockupStatusFilter>("all");
  const [selectedShopId, setSelectedShopId] = useState("");
  const [processingShopId, setProcessingShopId] = useState("");
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const [productImageRules, setProductImageRules] = useState<CloudProductImageRule[]>([]);
  const [selectedProductImageRuleId, setSelectedProductImageRuleId] = useState("");
  const [uploadSource, setUploadSource] = useState<UploadSource>("files");
  const [localUploadSelection, setLocalUploadSelection] = useState<GalleryUploadSelection | null>(null);
  const [localUploadPicking, setLocalUploadPicking] = useState(false);
  const [galleryUploadJobs, setGalleryUploadJobs] = useState<JobSummary[]>([]);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadErrors, setUploadErrors] = useState<UploadError[]>([]);
  const [uploadTask, setUploadTask] = useState<UploadTaskSnapshot | null>(() => readUploadTaskSnapshot());
  const [uploadHistory, setUploadHistory] = useState<UploadTaskSnapshot[]>(() => readUploadTaskHistory());
  const [cloudUser, setCloudUser] = useState<CloudUser | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>(() => defaultViewModeForTab(mode));
  const [pageSize, setPageSize] = useState(() => defaultPageSizeForTab(mode, defaultPageSize));
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const latestAssetsRequestRef = useRef(0);
  const latestVisibleAssetsRequestRef = useRef(0);
  const [renderingAssetId, setRenderingAssetId] = useState("");
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set());
  const [batchMockupProgress, setBatchMockupProgress] = useState<MockupBatchProgress | null>(null);
  const [mockupNotice, setMockupNotice] = useState<MockupNotice | null>(null);
  const [mockupErrors, setMockupErrors] = useState<UploadError[]>([]);
  const [mockupTemplates, setMockupTemplates] = useState<CloudMockupTemplate[]>(fallbackMockupTemplates);
  const [selectedMockupTemplate, setSelectedMockupTemplate] = useState("fangjin");
  const [previewAsset, setPreviewAsset] = useState<CloudAsset | null>(null);
  const [titlePromptTemplates, setTitlePromptTemplates] = useState<CloudTitlePromptTemplate[]>([]);
  const [selectedTitlePromptId, setSelectedTitlePromptId] = useState("");
  const [titlePromptName, setTitlePromptName] = useState("Ozon 标题模板");
  const [titlePrompt, setTitlePrompt] = useState(defaultTitlePrompt);
  const [productTemplates, setProductTemplates] = useState<CloudProductTemplate[]>([]);
  const [localProductTemplates, setLocalProductTemplates] = useState<TemplateSummary[]>([]);
  const [warehousesByShopId, setWarehousesByShopId] = useState<Record<string, WarehouseOption[]>>({});
  const [actionsByShopId, setActionsByShopId] = useState<Record<string, ActionOption[]>>({});
  const [loadingShopOptions, setLoadingShopOptions] = useState<Record<string, boolean>>({});
  const [shopListingConfigs, setShopListingConfigs] = useState<ShopListingConfig[]>([]);
  const listingPreferencesSnapshotRef = useRef<CloudListingPreferences>({});
  const latestListingShopsRef = useRef({ shops, localShops });
  const cloudListingShopPropsWaitersRef = useRef(new Set<(shops: CloudShop[]) => void>());
  const localListingShopPropsWaitersRef = useRef(new Set<(shops: Shop[]) => void>());
  latestListingShopsRef.current = { shops, localShops };
  const [listingDrafts, setListingDrafts] = useState<Record<string, ListingAssetDraft>>({});
  const [listingProgress, setListingProgress] = useState<ListingProgress | null>(null);
  const [dailyListingStats, setDailyListingStats] = useState<ShopDailyListingStat[]>([]);
  const [dailyListingStatsLoading, setDailyListingStatsLoading] = useState(false);
  const [dailyListingStatsError, setDailyListingStatsError] = useState("");
  const [listingReconciliation, setListingReconciliation] = useState<CloudListingReconciliationSummary | null>(null);
  const [listingReconciliationLoading, setListingReconciliationLoading] = useState(false);
  const [listingReconciliationError, setListingReconciliationError] = useState("");
  const [todayListingDate, setTodayListingDate] = useState(() => localDateString(new Date()));
  const [activeAutoListingRuns, setActiveAutoListingRuns] = useState(0);
  const [pendingAutoSubmitBatchIds, setPendingAutoSubmitBatchIds] = useState<Set<string>>(new Set());
  const [autoSubmittingBatchIds, setAutoSubmittingBatchIds] = useState<Set<string>>(new Set());
  const [repairImageProgress, setRepairImageProgress] = useState<RepairImageProgress | null>(null);
  const [repairImageJobId, setRepairImageJobId] = useState("");
  const [lastListingBatch, setLastListingBatch] = useState<CloudListingBatch | null>(null);
  const [localProcessingAssets, setLocalProcessingAssets] = useState<CloudAsset[]>(() => readStoredLocalProcessingAssets(cloudApiBaseUrl));
  const [localPreparationTasks, setLocalPreparationTasks] = useState<LocalPreparationTask[]>(() => readStoredLocalPreparationTasks(cloudApiBaseUrl));
  const [resumingListingBatchIds, setResumingListingBatchIds] = useState<Set<string>>(new Set());
  const [resumingPreparationTaskIds, setResumingPreparationTaskIds] = useState<Set<string>>(new Set());
  const [processingResumeNotice, setProcessingResumeNotice] = useState("");
  const [deleteConfirmAssetId, setDeleteConfirmAssetId] = useState("");
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);
  const [deleteUploadsConfirm, setDeleteUploadsConfirm] = useState(false);
  const [deletingUploads, setDeletingUploads] = useState(false);
  const [listingPreferencesLoaded, setListingPreferencesLoaded] = useState(false);
  const [localListingSetupLoaded, setLocalListingSetupLoaded] = useState(false);
  const [listingSetupPhase, setListingSetupPhase] = useState<ListingSetupPhase>("loading");
  const [autoResumeRetryTick, setAutoResumeRetryTick] = useState(0);
  const [listingPreferenceStatus, setListingPreferenceStatus] = useState("正在加载上架设置");
  const hasSavedListingPreferencesRef = useRef(false);
  const lastSavedListingPreferencesRef = useRef("");
  const autoResumeAttemptedBatchIdsRef = useRef<Set<string>>(new Set());
  const autoResumeAttemptedPreparationTaskIdsRef = useRef<Set<string>>(new Set());
  const runningPreparationTaskIdsRef = useRef<Set<string>>(new Set());
  const legacyPreparationResumeKeyRef = useRef("");
  const autoSubmitAttemptCountRef = useRef<Map<string, number>>(new Map());
  const lastGalleryUploadSuccessCountRef = useRef(0);
  const mountedRef = useRef(true);

  const selectedShopOptions = useMemo(() => shops.map((shop) => ({
    id: readExternalShopId(shop),
    name: shop.name,
  })), [shops]);
  const listingShopOptions = useMemo(() => {
    const byId = new Map<string, { id: string; name: string }>();
    for (const shop of localShops) {
      byId.set(shop.id, { id: shop.id, name: shop.name });
    }
    for (const shop of selectedShopOptions) {
      byId.set(shop.id, shop);
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" }));
  }, [localShops, selectedShopOptions]);
  const selectedShopNameById = useMemo(() => new Map([
    ...localShops.map((shop) => [shop.id, shop.name] as const),
    ...selectedShopOptions.map((shop) => [shop.id, shop.name] as const),
  ]), [localShops, selectedShopOptions]);
  const localShopByExternalId = useMemo(() => new Map(localShops.map((shop) => [shop.id, shop])), [localShops]);
  const localProcessingAssetIds = useMemo(() => new Set(localProcessingAssets.map((asset) => asset.id)), [localProcessingAssets]);
  const localOnlyProcessingAssetIds = useMemo(
    () => new Set(localProcessingAssets.filter((asset) => !asset.listingStatus?.batchId).map((asset) => asset.id)),
    [localProcessingAssets],
  );
  const localProcessingAssetIdsKey = useMemo(() => [...localProcessingAssetIds].sort().join("|"), [localProcessingAssetIds]);
  const localPreparationTaskAssetIds = useMemo(() => new Set(localPreparationTasks.flatMap((task) => task.assetIds)), [localPreparationTasks]);
  const activeLocalProcessingAssetIds = useMemo(
    () => new Set(localProcessingAssets
      .filter((asset) => !asset.listingStatus?.batchId && localPreparationTaskAssetIds.has(asset.id))
      .map((asset) => asset.id)),
    [localProcessingAssets, localPreparationTaskAssetIds],
  );
  const orphanPreparationAssets = useMemo(
    () => localProcessingAssets.filter((asset) => !asset.listingStatus?.batchId && !localPreparationTaskAssetIds.has(asset.id)),
    [localProcessingAssets, localPreparationTaskAssetIds],
  );
  const visibleAssets = useMemo(() => {
    if (tab === "pending") {
      return assets
        .filter((asset) => !asset.listingStatus && !activeLocalProcessingAssetIds.has(asset.id))
        .slice(0, pageSize);
    }
    return assets.slice(0, pageSize);
  }, [assets, tab, activeLocalProcessingAssetIds, pageSize]);
  const processingOverviewAssets = useMemo(() => {
    if (tab !== "processing") {
      return visibleAssets;
    }
    const localAssets = filterLocalProcessingAssets(
      localProcessingAssets.filter((asset) => !asset.listingStatus?.batchId && activeLocalProcessingAssetIds.has(asset.id)),
      { productImageRuleId: selectedProductImageRuleId, keyword, externalShopId: processingShopId },
    );
    return localAssets.length > 0 ? localAssets : assets;
  }, [assets, tab, localProcessingAssets, activeLocalProcessingAssetIds, selectedProductImageRuleId, keyword, processingShopId, visibleAssets]);
  const displayTotal = total;
  const pageCount = Math.max(1, Math.ceil(displayTotal / pageSize));
  const selectedAssets = useMemo(
    () => visibleAssets.filter((asset) => selectedAssetIds.has(asset.id)),
    [visibleAssets, selectedAssetIds],
  );
  const selectedUploadedAssets = useMemo(
    () => selectedAssets.filter((asset) => tab === "uploaded" && asset.listingStatus),
    [selectedAssets, tab],
  );
  const selectedDeletableAssets = useMemo(
    () => selectedAssets.filter((asset) => tab === "pending" && !asset.listingStatus),
    [selectedAssets, tab],
  );
  const selectableAssets = useMemo(
    () => visibleAssets.filter((asset) => (
      (tab === "pending" && !asset.listingStatus)
      || (tab === "uploaded" && Boolean(asset.listingStatus))
    )),
    [visibleAssets, tab],
  );
  const currentMockupTemplate = useMemo(
    () => mockupTemplates.find((template) => template.id === selectedMockupTemplate) ?? mockupTemplates[0],
    [mockupTemplates, selectedMockupTemplate],
  );
  const currentMockupTemplateName = currentMockupTemplate?.name ?? "当前样机";
  const pageAssetsWithoutCurrentMockup = useMemo(
    () => visibleAssets.filter((asset) => !asset.listingStatus && !hasMockupResults(asset, selectedMockupTemplate)),
    [visibleAssets, selectedMockupTemplate],
  );
  const selectedAssetsWithoutCurrentMockup = useMemo(
    () => selectedAssets.filter((asset) => !asset.listingStatus && !hasMockupResults(asset, selectedMockupTemplate)),
    [selectedAssets, selectedMockupTemplate],
  );
  const selectedRenderedCount = selectedAssets.length - selectedAssetsWithoutCurrentMockup.length;
  const selectedListingReadyAssets = useMemo(
    () => selectedAssets.filter((asset) => !asset.listingStatus && hasMockupResults(asset, selectedMockupTemplate)),
    [selectedAssets, selectedMockupTemplate],
  );
  const selectedBlockedListingCount = selectedAssets.length - selectedListingReadyAssets.length;
  const activeShopListingConfigs = useMemo(
    () => shopListingConfigs.filter((config) => selectedShopNameById.has(config.externalShopId) || localShopByExternalId.has(config.externalShopId)),
    [shopListingConfigs, selectedShopNameById, localShopByExternalId],
  );
  const dailyListingStatsByShopId = useMemo(
    () => mapDailyListingStatsByShop(dailyListingStats, todayListingDate),
    [dailyListingStats, todayListingDate],
  );
  const selectedListingCountsByShopId = useMemo(
    () => countListingAssignments(selectedAssets, listingDrafts, activeShopListingConfigs),
    [selectedAssets, listingDrafts, activeShopListingConfigs],
  );
  const listingQuotaSnapshots = useMemo(
    () => buildListingQuotaSnapshots(activeShopListingConfigs, dailyListingStatsByShopId, selectedListingCountsByShopId),
    [activeShopListingConfigs, dailyListingStatsByShopId, selectedListingCountsByShopId],
  );
  const listingQuotaByShopId = useMemo(
    () => new Map(listingQuotaSnapshots.map((quota) => [quota.externalShopId, quota])),
    [listingQuotaSnapshots],
  );
  const selectedListingQuotaWarnings = useMemo(
    () => buildListingQuotaWarnings(listingQuotaSnapshots, selectedShopNameById),
    [listingQuotaSnapshots, selectedShopNameById],
  );
  const autoListingSummary = useMemo(
    () => buildAutoListingSummary(listingQuotaSnapshots.map((quota) => ({
      externalShopId: quota.externalShopId,
      shopName: selectedShopNameById.get(quota.externalShopId) ?? quota.externalShopId,
      limit: quota.limit,
      listedCount: quota.listedCount,
      pendingCount: quota.pendingCount,
      reservedCount: quota.reservedCount,
      failedCount: 0,
    }))),
    [listingQuotaSnapshots, selectedShopNameById],
  );
  const activePreparationTasks = useMemo(
    () => localPreparationTasks.filter((task) => task.status !== "prepared"),
    [localPreparationTasks],
  );
  const recoveryPreparationTasks = useMemo(
    () => activePreparationTasks.filter((task) => task.assetIds.some((assetId) => localOnlyProcessingAssetIds.has(assetId))),
    [activePreparationTasks, localOnlyProcessingAssetIds],
  );
  const processingSummary = useMemo(
    () => buildProcessingSummary(processingOverviewAssets, selectedMockupTemplate, currentMockupTemplate, recoveryPreparationTasks, undefined, listingDrafts),
    [processingOverviewAssets, selectedMockupTemplate, currentMockupTemplate, recoveryPreparationTasks, listingDrafts],
  );
  const processingOverviewTotal = listingReconciliation?.processingCount ?? processingSummary.total;
  const processingTitlePending = Math.max(0, processingOverviewTotal - processingSummary.titleDone);
  const processingTotalText = `${processingOverviewTotal}`;
  const processingListingBatchIds = useMemo(
    () => collectProcessingListingBatchIds(processingOverviewAssets),
    [processingOverviewAssets],
  );
  const allProcessingListingBatchIds = useMemo(
    () => [...new Set([...processingListingBatchIds, ...pendingAutoSubmitBatchIds].filter((batchId) => isUuid(batchId)))],
    [processingListingBatchIds, pendingAutoSubmitBatchIds],
  );
  const activePreparationTaskByAssetId = useMemo(() => {
    const next = new Map<string, LocalPreparationTask>();
    for (const task of recoveryPreparationTasks) {
      for (const assetId of task.assetIds) {
        next.set(assetId, task);
      }
    }
    return next;
  }, [recoveryPreparationTasks]);
  const processingBatchIdsKey = processingListingBatchIds.join("|");
  const preparationTaskIdsKey = recoveryPreparationTasks.map((task) => `${task.id}:${task.status}:${task.updatedAt}`).join("|");
  const pendingAutoSubmitBatchIdsKey = useMemo(() => [...pendingAutoSubmitBatchIds].sort().join("|"), [pendingAutoSubmitBatchIds]);
  const autoSubmittingBatchIdsKey = useMemo(() => [...autoSubmittingBatchIds].sort().join("|"), [autoSubmittingBatchIds]);
  const isResumingProcessingBatches = allProcessingListingBatchIds.some((batchId) => resumingListingBatchIds.has(batchId));
  const isResumingPreparationTasks = resumingPreparationTaskIds.size > 0 || activeAutoListingRuns > 0;
  const isResumingUploadTasks = isResumingProcessingBatches || isResumingPreparationTasks;
  const pendingUploadTaskCount = allProcessingListingBatchIds.length + recoveryPreparationTasks.length;
  const visibleListingShopProgress = useMemo(
    () => mergeListingShopProgress(
      listingReconciliation?.shops ?? [],
      buildLocalPreparationShopProgress(recoveryPreparationTasks, selectedShopNameById),
      processingShopId,
    ),
    [listingReconciliation, recoveryPreparationTasks, selectedShopNameById, processingShopId],
  );
  const autoListingTaskCenterSummary = useMemo(
    () => buildAutoListingTaskCenterSummary(listingReconciliation),
    [listingReconciliation],
  );
  const autoListingTaskCenterTasks = useMemo(
    () => buildAutoListingTaskCenterTasks(listingReconciliation, lastListingBatch),
    [listingReconciliation, lastListingBatch],
  );
  const uploadResumeBusy = isResumingProcessingBatches || resumingPreparationTaskIds.size > 0;
  const isPreparingAutoListing = activeAutoListingRuns > 0;
  const selectedProductImageRule = useMemo(
    () => productImageRules.find((rule) => rule.id === selectedProductImageRuleId) ?? null,
    [productImageRules, selectedProductImageRuleId],
  );
  const selectedProductRuleText = selectedProductImageRule ? productImageRuleLabel(selectedProductImageRule) : "";
  const setSelectedProductRule = (ruleId: string) => {
    setSelectedProductImageRuleId(ruleId);
    const rule = productImageRules.find((item) => item.id === ruleId);
    setRatioFamily(rule ? ratioFamilyForAspectRatio(rule.aspectRatio) : "");
    if (tab !== "upload") {
      setPage(1);
      void loadAssets(1, tab, { productImageRuleIdOverride: ruleId });
    }
  };
  const selectedListingTargetText = selectedAssets.length > 0 ? `选中 ${selectedAssets.length} 张` : "先选择图片";
  const oneClickListingDisabledReason = buildOneClickListingDisabledReason({
    isPending: tab === "pending",
    selectedCount: selectedAssets.length,
    productImageRuleId: selectedProductImageRuleId,
    shopCount: activeShopListingConfigs.length,
    setupLoaded: listingPreferencesLoaded && localListingSetupLoaded,
    hasIncompleteShop: activeShopListingConfigs.some((config) => !(config.productTemplateId || config.productTemplateName || config.newTemplateName).trim()),
    hasMissingLocalTemplate: activeShopListingConfigs.some((config) => !config.localTemplateId),
    localShopCount: localShops.length,
  });
  const currentPageOneClickDisabledReason = buildOneClickListingDisabledReason({
    isPending: tab === "pending",
    selectedCount: selectableAssets.length,
    productImageRuleId: selectedProductImageRuleId,
    shopCount: activeShopListingConfigs.length,
    setupLoaded: listingPreferencesLoaded && localListingSetupLoaded,
    hasIncompleteShop: activeShopListingConfigs.some((config) => !(config.productTemplateId || config.productTemplateName || config.newTemplateName).trim()),
    hasMissingLocalTemplate: activeShopListingConfigs.some((config) => !config.localTemplateId),
    localShopCount: localShops.length,
  }) || (selectableAssets.length === 0 ? "当前页没有可上架的待上传图片" : "");
  const configuredShopSummary = activeShopListingConfigs
    .map((config) => {
      const shopName = selectedShopNameById.get(config.externalShopId) ?? "店铺";
      const templateName = config.productTemplateName || config.newTemplateName || localProductTemplates.find((template) => template.id === config.localTemplateId)?.name || "\u672a\u9009\u6a21\u677f";
      return `${shopName} / ${templateName}`;
    })
    .join("\u3001");
  const autoResumeSetupKey = useMemo(
    () => [
      activeShopListingConfigs.map((config) => `${config.externalShopId}:${config.localTemplateId}`).join("|"),
      localShops.map((shop) => shop.id).join("|"),
      localProductTemplates.map((template) => template.id).join("|"),
    ].join("::"),
    [activeShopListingConfigs, localShops, localProductTemplates],
  );
  const sharedProductTemplates = useMemo(
    () => productTemplates.filter((template) => template.shared || template.externalShopId === SHARED_PRODUCT_TEMPLATE_SHOP_ID),
    [productTemplates],
  );

  const commitUploadTask = (next: UploadTaskSnapshot | null) => {
    writeUploadTaskSnapshot(next);
    if (mountedRef.current) {
      setUploadTask(next);
      setUploadHistory(readUploadTaskHistory());
    }
  };

  const finishUploadTask = (next: UploadTaskSnapshot) => {
    writeUploadTaskSnapshot(next);
    pushUploadTaskHistory(next);
    if (mountedRef.current) {
      setUploadTask(next);
      setUploadHistory(readUploadTaskHistory());
    }
  };

  const clearUploadTask = () => {
    commitUploadTask(null);
    setUploadFiles([]);
    setUploadProgress(null);
    setUploadErrors([]);
  };
  const uploadPlan = useMemo(() => createUploadPlan(uploadFiles), [uploadFiles]);
  const galleryStorageUsedBytes = cloudUser?.galleryStorageUsedBytes ?? 0;
  const galleryStorageLimitBytes = cloudUser?.galleryStorageLimitBytes ?? 0;
  const galleryStorageRemainingBytes = galleryStorageLimitBytes > 0
    ? Math.max(0, galleryStorageLimitBytes - galleryStorageUsedBytes)
    : Number.POSITIVE_INFINITY;
  const uploadExceedsStorage = galleryStorageLimitBytes > 0 && uploadPlan.totalBytes > galleryStorageRemainingBytes;
  const localUploadExceedsStorage = Boolean(
    localUploadSelection
    && galleryStorageLimitBytes > 0
    && localUploadSelection.totalBytes > galleryStorageRemainingBytes,
  );

  const refreshGalleryUploadJobs = useCallback(async () => {
    const jobs = await api.listJobs();
    setGalleryUploadJobs(jobs.filter((job) => job.kind === "gallery_upload"));
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!getCloudToken()) return;
    client.me()
      .then((result) => setCloudUser(result.user))
      .catch(() => undefined);
  }, [client, uploadTask?.status]);

  useEffect(() => {
    if (tab !== "upload" && tab !== "pending") {
      return undefined;
    }
    const refreshUploadTask = () => {
      setUploadTask(readUploadTaskSnapshot());
      setUploadHistory(readUploadTaskHistory());
    };
    refreshUploadTask();
    const timer = window.setInterval(refreshUploadTask, 1000);
    return () => window.clearInterval(timer);
  }, [tab]);

  useEffect(() => {
    if (!selectedShopId && selectedShopOptions.length > 0) {
      setSelectedShopId(selectedShopOptions[0].id);
    }
  }, [selectedShopId, selectedShopOptions]);

  useEffect(() => {
    if (tab !== mode) {
      switchTab(mode);
    }
  }, [mode]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeStoredLocalProcessingAssets(cloudApiBaseUrl, localProcessingAssets);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [cloudApiBaseUrl, localProcessingAssets]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      writeStoredLocalPreparationTasks(cloudApiBaseUrl, localPreparationTasks);
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [cloudApiBaseUrl, localPreparationTasks]);

  useEffect(() => {
    const expectedViewMode = defaultViewModeForTab(mode);
    if (viewMode !== expectedViewMode) {
      setViewMode(expectedViewMode);
    }
  }, [mode]);

  useEffect(() => {
    setBulkDeleteConfirm(false);
  }, [selectedAssetIds, tab]);

  useEffect(() => {
    const updateTodayListingDate = () => {
      const nextDate = localDateString(new Date());
      setTodayListingDate((current) => current === nextDate ? current : nextDate);
    };
    updateTodayListingDate();
    const intervalId = window.setInterval(updateTodayListingDate, 60_000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (shops.length > 0) {
      cloudListingShopPropsWaitersRef.current.forEach((resolve) => resolve(shops));
      cloudListingShopPropsWaitersRef.current.clear();
    }
    if (localShops.length > 0) {
      localListingShopPropsWaitersRef.current.forEach((resolve) => resolve(localShops));
      localListingShopPropsWaitersRef.current.clear();
    }
    if (listingSetupPhase === "loading") {
      return;
    }
    setShopListingConfigs((current) => {
      const next = mergeListingShops({
        cloudShops: shops,
        localShops,
        savedConfigs: [],
        currentConfigs: current,
      });
      return next;
    });
  }, [listingSetupPhase, shops, localShops]);

  useEffect(() => {
    if (mode !== "upload") {
      loadAssets(1, mode);
    }
    loadMockupTemplates();
    initializeListingSetup();
  }, []);

  useEffect(() => {
    activeShopListingConfigs.forEach((config) => {
      ensureShopOperationOptions(config.externalShopId).catch((error) => {
        onMessage(error instanceof Error ? error.message : String(error));
      });
    });
  }, [activeShopListingConfigs, localShops]);

  useEffect(() => {
    if (activeShopListingConfigs.length === 0) {
      return;
    }
    setListingDrafts((current) => {
      let changed = false;
      const next = { ...current };
      selectedAssets.forEach((asset, index) => {
        if (!asset.listingStatus && !next[asset.id]) {
          next[asset.id] = createListingDraftFromAsset(asset, activeShopListingConfigs[index % activeShopListingConfigs.length].externalShopId);
          changed = true;
        }
      });
      return changed ? next : current;
    });
  }, [activeShopListingConfigs, selectedAssets]);

  useEffect(() => {
    setListingDrafts((current) => syncGeneratedTitlesToDrafts(current, assets));
  }, [assets]);

  useEffect(() => {
    if (listingSetupPhase !== "ready") {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      saveListingPreferences("auto").catch((error) => {
        setListingPreferenceStatus(`上架设置加载失败：${error instanceof Error ? error.message : String(error)}`);
      });
    }, 900);
    return () => window.clearTimeout(timeoutId);
  }, [
    listingSetupPhase,
    selectedProductImageRuleId,
    selectedShopId,
    selectedMockupTemplate,
    selectedTitlePromptId,
    titlePromptName,
    titlePrompt,
    shopListingConfigs,
  ]);

  useEffect(() => {
    if (tab !== "processing") {
      return undefined;
    }
    void loadListingReconciliation({ silent: true });
    const timer = window.setInterval(() => {
      if (!loading) {
        loadAssets(page, "processing", { silent: true });
        loadListingReconciliation({ silent: true });
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [tab, loading, page, pageSize, selectedProductImageRuleId, keyword, processingShopId, selectedMockupTemplate, mockupStatus, todayListingDate]);

  useEffect(() => {
    if (tab !== "upload" && tab !== "pending") {
      return undefined;
    }
    let disposed = false;
    const refreshGalleryUploadJobs = async () => {
      try {
        const jobs = await api.listJobs();
        if (disposed) {
          return;
        }
        const uploadJobs = jobs.filter((job) => job.kind === "gallery_upload");
        setGalleryUploadJobs(uploadJobs);
        const successCount = uploadJobs.reduce((sum, job) => sum + (job.successCount ?? 0), 0);
        if (tab === "pending" && successCount !== lastGalleryUploadSuccessCountRef.current) {
          lastGalleryUploadSuccessCountRef.current = successCount;
          await loadAssets(1, "pending", { silent: true });
        } else {
          lastGalleryUploadSuccessCountRef.current = successCount;
        }
      } catch {
        // ??????????????????????????
      }
    };
    void refreshGalleryUploadJobs();
    const timer = window.setInterval(refreshGalleryUploadJobs, 2000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [tab]);

  useEffect(() => {
    if (!repairImageJobId) {
      return undefined;
    }
    let disposed = false;
    const refreshRepairJob = async () => {
      try {
        const jobs = await api.listJobs();
        if (disposed) {
          return;
        }
        const job = jobs.find((item) => item.id === repairImageJobId);
        if (!job) {
          return;
        }
        setRepairImageProgress((current) => ({
          phase: repairJobPhase(job),
          message: repairJobMessage(job),
          scanned: current?.scanned,
          total: current?.total,
          skipped: current?.skipped,
          job,
        }));
        if (job.status !== "queued" && job.status !== "running") {
          setRepairImageJobId("");
        }
      } catch {
        // The repair job may run in the local assistant; keep the last visible progress if polling fails briefly.
      }
    };
    void refreshRepairJob();
    const timer = window.setInterval(refreshRepairJob, 1000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [repairImageJobId]);

  useEffect(() => {
    autoResumeAttemptedBatchIdsRef.current.clear();
    autoResumeAttemptedPreparationTaskIdsRef.current.clear();
    legacyPreparationResumeKeyRef.current = "";
  }, [autoResumeSetupKey]);

  useEffect(() => {
    if (
      !listingPreferencesLoaded
      || !localListingSetupLoaded
      || localShops.length === 0
      || pendingUploadTaskCount === 0
      || runningPreparationTaskIdsRef.current.size > 0
    ) {
      return;
    }
    resumeLocalPreparationTasks("auto").catch((error) => {
      onMessage(error instanceof Error ? error.message : String(error));
    });
  }, [
    listingPreferencesLoaded,
    localListingSetupLoaded,
    localShops,
    preparationTaskIdsKey,
    localProcessingAssetIdsKey,
    pendingUploadTaskCount,
    autoResumeSetupKey,
    autoResumeRetryTick,
  ]);

  useEffect(() => {
    if (
      tab !== "processing"
      || !listingPreferencesLoaded
      || loading
      || processingListingBatchIds.length === 0
      || localShops.length === 0
    ) {
      return;
    }
    const pendingBatchIds = processingListingBatchIds.filter((batchId) => !autoResumeAttemptedBatchIdsRef.current.has(batchId));
    if (pendingBatchIds.length === 0) {
      return;
    }
    pendingBatchIds.forEach((batchId) => autoResumeAttemptedBatchIdsRef.current.add(batchId));
    void resumeProcessingListingBatches(pendingBatchIds, "auto").then((failedBatchIds) => {
      failedBatchIds.forEach((batchId) => autoResumeAttemptedBatchIdsRef.current.delete(batchId));
    }).catch(() => {
      pendingBatchIds.forEach((batchId) => autoResumeAttemptedBatchIdsRef.current.delete(batchId));
    });
  }, [
    tab,
    listingPreferencesLoaded,
    loading,
    processingBatchIdsKey,
    localShops,
    autoResumeSetupKey,
    autoResumeRetryTick,
  ]);

  useEffect(() => {
    if (tab !== "processing" || (processingListingBatchIds.length === 0 && activePreparationTasks.length === 0)) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      processingListingBatchIds.forEach((batchId) => autoResumeAttemptedBatchIdsRef.current.delete(batchId));
      activePreparationTasks.forEach((task) => autoResumeAttemptedPreparationTaskIdsRef.current.delete(task.id));
      setAutoResumeRetryTick((current) => current + 1);
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [tab, processingBatchIdsKey, preparationTaskIdsKey]);


  useEffect(() => {
    if (
      pendingAutoSubmitBatchIds.size === 0
      || !listingPreferencesLoaded
      || !localListingSetupLoaded
      || localShops.length === 0
    ) {
      return undefined;
    }

    const readyBatchIds = [...pendingAutoSubmitBatchIds]
      .filter((batchId) => !autoSubmittingBatchIds.has(batchId))
      .slice(0, autoSubmitBatchConcurrency);
    if (readyBatchIds.length === 0) {
      return undefined;
    }

    let disposed = false;
    const timer = window.setTimeout(() => {
      if (disposed) {
        return;
      }
      readyBatchIds.forEach((batchId) => {
        autoSubmitPreparedBatch(batchId).catch((error) => {
          onMessage(error instanceof Error ? error.message : String(error));
        });
      });
    }, 1200);

    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
  }, [
    pendingAutoSubmitBatchIdsKey,
    autoSubmittingBatchIdsKey,
    listingPreferencesLoaded,
    localListingSetupLoaded,
    localShops,
    autoResumeSetupKey,
  ]);

  const loadAssets = async (
    nextPage = page,
    sourceTab = tab,
    options: { silent?: boolean; pageSizeOverride?: number; externalShopIdOverride?: string; excludeAssetIdsOverride?: string[]; productImageRuleIdOverride?: string; includeTotal?: boolean } = {},
  ) => {
    const requestId = latestAssetsRequestRef.current + 1;
    latestAssetsRequestRef.current = requestId;
    if (!options.silent) {
      latestVisibleAssetsRequestRef.current = requestId;
      setLoading(true);
    }
    try {
      const effectivePageSize = options.pageSizeOverride ?? pageSize;
      const productImageRuleFilter = options.productImageRuleIdOverride ?? selectedProductImageRuleId;
      const listingShopFilter = sourceTab === "processing" || sourceTab === "uploaded"
        ? (options.externalShopIdOverride ?? processingShopId) || undefined
        : undefined;
      const cachedProcessingAssets = sourceTab === "processing"
        ? filterLocalProcessingAssets(localProcessingAssets, {
          productImageRuleId: productImageRuleFilter,
          keyword,
          externalShopId: listingShopFilter,
        })
        : [];
      const hasProcessingFilter = Boolean(productImageRuleFilter || keyword.trim() || listingShopFilter);
      const processingLocalAssets = cachedProcessingAssets.filter((asset) => (
        !asset.listingStatus?.batchId
        && activeLocalProcessingAssetIds.has(asset.id)
        && (!hasProcessingFilter || localPreparationTaskAssetIds.has(asset.id))
      ));
      const processingPageStart = (nextPage - 1) * effectivePageSize;
      const processingPageEnd = processingPageStart + effectivePageSize;
      const processingLocalPageAssets = processingLocalAssets.slice(processingPageStart, processingPageEnd);
      const serverLimit = sourceTab === "processing"
        ? Math.max(1, effectivePageSize - processingLocalPageAssets.length)
        : effectivePageSize;
      const serverOffset = sourceTab === "processing"
        ? Math.max(0, processingPageStart - processingLocalAssets.length)
        : processingPageStart;
      const includeTotal = options.includeTotal ?? (!options.silent && (nextPage === 1 || total === 0 || sourceTab !== tab));
      const query = {
        productImageRuleId: productImageRuleFilter || undefined,
        keyword: keyword.trim() || undefined,
        externalShopId: listingShopFilter,
        excludeAssetIds: sourceTab === "pending"
          ? (options.excludeAssetIdsOverride ?? [...activeLocalProcessingAssetIds])
          : undefined,
        limit: serverLimit,
        offset: serverOffset,
        includeTotal,
      } satisfies GalleryQuery;
      const listingStatus = sourceTab === "processing" ? "processing" : sourceTab === "uploaded" ? "uploaded" : "pending";
      const result = sourceTab === "featured"
        ? await client.listFeaturedAssets(query)
        : await client.listAssets({
          ...query,
          hideUsed: sourceTab === "pending" ? hideUsed : false,
          listingStatus,
          mockupTemplateId: selectedMockupTemplate,
          mockupStatus: sourceTab === "pending" ? mockupStatus : "all",
      });
      if (requestId !== latestAssetsRequestRef.current) return;
      const serverTotal = typeof result.total === "number"
        ? result.total
        : sourceTab === tab && total > 0
          ? total
          : result.assets.length;
      const useCachedProcessingFallback = sourceTab === "processing"
        && serverTotal === 0
        && result.assets.length === 0
        && processingLocalAssets.length > 0
        && !productImageRuleFilter
        && !keyword.trim()
        && !listingShopFilter;
      const hasAuthoritativeLocalProcessing = sourceTab === "processing" && processingLocalAssets.length > 0;
      const nextAssets = hasAuthoritativeLocalProcessing
        ? processingLocalPageAssets
        : useCachedProcessingFallback
          ? processingLocalAssets.slice(processingPageStart, processingPageEnd)
          : sourceTab === "processing"
            ? mergeCloudAndLocalProcessingAssets(result.assets, processingLocalPageAssets).slice(0, effectivePageSize)
            : result.assets.slice(0, effectivePageSize);
      const nextTotal = hasAuthoritativeLocalProcessing
        ? processingLocalAssets.length
        : useCachedProcessingFallback
          ? processingLocalAssets.length
          : serverTotal;
      setAssets(nextAssets);
      const visibleAssetIds = new Set(nextAssets.map((asset) => asset.id));
      if (sourceTab === "processing" && !useCachedProcessingFallback) {
        const cloudProcessingAssetIds = new Set(result.assets.filter((asset) => asset.listingStatus).map((asset) => asset.id));
        updateLocalProcessingAssets((current) => current.filter((asset) => (
          !cloudProcessingAssetIds.has(asset.id)
          && (serverTotal > 0 || !asset.listingStatus?.batchId)
        )));
      } else if (sourceTab === "uploaded") {
        const uploadedAssetIds = new Set(result.assets.map((asset) => asset.id));
        updateLocalProcessingAssets((current) => current.filter((asset) => !uploadedAssetIds.has(asset.id)));
      }
      setSelectedAssetIds((current) => {
        const next = new Set<string>();
        for (const assetId of current) {
          if (visibleAssetIds.has(assetId)) {
            next.add(assetId);
          }
        }
        return next;
      });
      setTotal(nextTotal);
      setPage(nextPage);
      if (!options.silent) {
        onMessage(`${galleryModeTitle(sourceTab)}已查询到 ${nextTotal} 张图片，当前显示 ${nextAssets.length} 张。`);
      }
    } catch (error) {
      if (!options.silent && requestId === latestAssetsRequestRef.current) {
        onMessage(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (!options.silent && requestId === latestVisibleAssetsRequestRef.current) {
        setLoading(false);
      }
    }
  };

  const loadTodayDailyListingStats = async (options: { silent?: boolean } = {}) => {
    if (!options.silent) {
      setDailyListingStatsLoading(true);
    }
    try {
      const result = await client.listDailyListingStats({
        dateFrom: todayListingDate,
        dateTo: todayListingDate,
      });
      setDailyListingStats(result.stats);
      setDailyListingStatsError("");
      return result.stats;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setDailyListingStatsError(message);
      if (!options.silent) {
        onMessage(message);
      }
      return null;
    } finally {
      if (!options.silent) {
        setDailyListingStatsLoading(false);
      }
    }
  };

  const loadListingReconciliation = async (options: { silent?: boolean } = {}) => {
    if (typeof client.listListingReconciliation !== "function") {
      return null;
    }
    if (!options.silent) {
      setListingReconciliationLoading(true);
    }
    try {
      const result = await client.listListingReconciliation({
        dateFrom: todayListingDate,
        dateTo: todayListingDate,
        externalShopId: processingShopId || undefined,
      });
      setListingReconciliation(result.summary);
      setListingReconciliationError("");
      return result.summary;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setListingReconciliationError(message);
      if (!options.silent) {
        onMessage(message);
      }
      return null;
    } finally {
      if (!options.silent) {
        setListingReconciliationLoading(false);
      }
    }
  };

  useEffect(() => {
    if (tab !== "pending" || activeShopListingConfigs.length === 0) {
      return;
    }
    void loadTodayDailyListingStats({ silent: true });
  }, [tab, activeShopListingConfigs.length, todayListingDate]);

  const search = () => {
    if (tab === "upload") {
      setUploadTask(readUploadTaskSnapshot());
      setUploadHistory(readUploadTaskHistory());
      return;
    }
    loadAssets(1);
  };

  const switchTab = (nextTab: GalleryTab) => {
    setTab(nextTab);
    setAssets([]);
    setTotal(0);
    setPage(1);
    const nextPageSize = defaultPageSizeForTab(nextTab, defaultPageSize);
    setPageSize(nextPageSize);
    setViewMode(defaultViewModeForTab(nextTab));
    if (nextTab !== "upload") {
      loadAssets(1, nextTab, { pageSizeOverride: nextPageSize });
    }
  };

  const loadMockupTemplates = async () => {
    try {
      const result = await client.listMockupTemplates();
      if (result.templates.length > 0) {
        setMockupTemplates(result.templates);
        setSelectedMockupTemplate((current) => (
          result.templates.some((template) => template.id === current) ? current : result.templates[0].id
        ));
      }
    } catch {
      setMockupTemplates(fallbackMockupTemplates);
    }
  };

  const loadInitialListingShops = async () => {
    const initial = latestListingShopsRef.current;
    const settleFromApiOrProps = <T,>(
      initialItems: T[],
      propsWaiters: Set<(items: T[]) => void>,
      loadItems: () => Promise<T[]>,
    ) => {
      if (initialItems.length > 0) {
        return Promise.resolve(initialItems);
      }
      let resolveFromProps!: (items: T[]) => void;
      const propsPromise = new Promise<T[]>((resolve) => {
        resolveFromProps = resolve;
        propsWaiters.add(resolve);
      });
      return Promise.race([loadItems(), propsPromise])
        .finally(() => propsWaiters.delete(resolveFromProps));
    };
    const [cloudResult, localResult] = await Promise.allSettled([
      settleFromApiOrProps(
        initial.shops,
        cloudListingShopPropsWaitersRef.current,
        () => client.listShops().then((result) => result.shops),
      ),
      settleFromApiOrProps(
        initial.localShops,
        localListingShopPropsWaitersRef.current,
        () => api.loadAppState().then((state) => state.shops),
      ),
    ]);
    const cloudShopsById = new Map<string, CloudShop>();
    if (cloudResult.status === "fulfilled") {
      cloudResult.value.forEach((shop) => cloudShopsById.set(readExternalShopId(shop), shop));
    }
    const localShopsById = new Map<string, Shop>();
    if (localResult.status === "fulfilled") {
      localResult.value.forEach((shop) => localShopsById.set(shop.id, shop));
    }
    const latest = latestListingShopsRef.current;
    latest.shops.forEach((shop) => cloudShopsById.set(readExternalShopId(shop), shop));
    latest.localShops.forEach((shop) => localShopsById.set(shop.id, shop));
    return {
      shops: [...cloudShopsById.values()],
      localShops: [...localShopsById.values()],
      errors: [cloudResult, localResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason)),
    };
  };
  const initializeListingSetup = async () => {
    setListingSetupPhase("loading");
    setListingPreferencesLoaded(false);
    setLocalListingSetupLoaded(false);
    const shopSourcesPromise = loadInitialListingShops();
    const results = await Promise.allSettled([
      client.getListingPreferences(),
      client.listTitlePromptTemplates(),
      client.listProductTemplates(),
      api.listTemplates(PRODUCT_TEMPLATE_KIND),
      typeof client.listProductImageRules === "function"
        ? client.listProductImageRules()
        : Promise.resolve({ ok: true, rules: [] }),
    ]);
    const [preferencesResult, promptsResult, productTemplatesResult, localTemplatesResult, productRulesResult] = results;
    const preferencesResponse = preferencesResult.status === "fulfilled"
      ? preferencesResult.value
      : { ok: false, preferences: {} as CloudListingPreferences, updatedAt: null };
    const preferences = preferencesResponse.preferences;
    const hasSavedPreferences = Boolean(preferencesResponse.updatedAt);
    const promptTemplates = promptsResult.status === "fulfilled" ? promptsResult.value.templates : [];
    const nextProductTemplates = productTemplatesResult.status === "fulfilled" ? productTemplatesResult.value.templates : [];
    const nextLocalProductTemplates = localTemplatesResult.status === "fulfilled" ? localTemplatesResult.value : [];
    const nextProductImageRules = productRulesResult.status === "fulfilled" ? productRulesResult.value.rules : [];
    setTitlePromptTemplates(promptTemplates);
    setProductTemplates(nextProductTemplates);
    setLocalProductTemplates(nextLocalProductTemplates);
    setProductImageRules(nextProductImageRules);
    applyListingPreferences(preferences, nextProductImageRules, promptTemplates, hasSavedPreferences);
    const settledShops = await shopSourcesPromise;
    const snapshot = buildInitialListingSetup({
      cloudShops: settledShops.shops,
      localShops: settledShops.localShops,
      preferences,
      currentShopListingConfigs: [],
      productTemplates: nextProductTemplates,
      localProductTemplates: nextLocalProductTemplates,
    });

    hasSavedListingPreferencesRef.current = hasSavedPreferences;
    lastSavedListingPreferencesRef.current = hasSavedPreferences ? serializeListingPreferences(preferences) : "";
    setShopListingConfigs(snapshot.shopListingConfigs);
    setListingPreferenceStatus(hasSavedPreferences
      ? "\u5df2\u6062\u590d\u4e0a\u6b21\u4e0a\u67b6\u8bbe\u7f6e"
      : "\u4e0a\u67b6\u8bbe\u7f6e\u4f1a\u81ea\u52a8\u4fdd\u5b58");

    const failedMessages = [
      ...results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason)),
      ...settledShops.errors,
    ];
    const preferencesFailed = preferencesResult.status === "rejected";
    setListingSetupPhase(preferencesFailed ? "error" : "ready");
    setListingPreferencesLoaded(true);
    setLocalListingSetupLoaded(true);
    if (failedMessages.length > 0) {
      const message = failedMessages.join("；");
      setListingPreferenceStatus(`${preferencesFailed ? "上架设置加载失败" : "上架设置部分数据加载失败"}：${message}`);
      onMessage(`上架设置部分数据加载失败：${message}`);
    }
  };

  const applyListingPreferences = (
    preferences: CloudListingPreferences,
    rules: CloudProductImageRule[],
    prompts: CloudTitlePromptTemplate[],
    hasSavedPreferences: boolean,
  ) => {
    const preferredRuleId = preferences.productImageRuleId
      || findProductRuleIdByRatioFamily(rules, preferences.ratioFamily || "")
      || (!hasSavedPreferences && (tab === "upload" || tab === "pending") ? rules[0]?.id ?? "" : "");
    setSelectedProductImageRuleId(preferredRuleId);
    setRatioFamily(rules.find((rule) => rule.id === preferredRuleId)
      ? ratioFamilyForAspectRatio(rules.find((rule) => rule.id === preferredRuleId)!.aspectRatio)
      : preferences.ratioFamily || "");
    setSelectedShopId(preferences.selectedShopId || "");
    if (preferences.selectedMockupTemplate) {
      setSelectedMockupTemplate(preferences.selectedMockupTemplate);
    }
    const defaultPrompt = !hasSavedPreferences ? prompts[0] : undefined;
    setSelectedTitlePromptId(preferences.selectedTitlePromptId || defaultPrompt?.id || "");
    if (preferences.titlePromptName?.trim()) {
      setTitlePromptName(preferences.titlePromptName);
    } else if (defaultPrompt) {
      setTitlePromptName(defaultPrompt.name);
    }
    if (preferences.titlePrompt?.trim()) {
      setTitlePrompt(preferences.titlePrompt);
    } else if (defaultPrompt) {
      setTitlePrompt(defaultPrompt.prompt);
    }
  };

  const buildListingPreferences = (configs: ShopListingConfig[] = shopListingConfigs): CloudListingPreferences => ({
    ratioFamily: (selectedProductImageRule ? ratioFamilyForAspectRatio(selectedProductImageRule.aspectRatio) : ratioFamily) as CloudListingPreferences["ratioFamily"],
    productImageRuleId: selectedProductImageRuleId,
    selectedShopId,
    selectedMockupTemplate,
    selectedTitlePromptId: isUuid(selectedTitlePromptId) ? selectedTitlePromptId : "",
    titlePromptName: trimText(titlePromptName, 80),
    titlePrompt: trimText(titlePrompt, 8000),
    shopListingConfigs: configs.map(shopListingConfigToPreference),
  });
  listingPreferencesSnapshotRef.current = buildListingPreferences();

  const saveListingPreferences = async (
    source: "auto" | "manual",
    preferences: CloudListingPreferences = listingPreferencesSnapshotRef.current,
  ) => {
    const serialized = serializeListingPreferences(preferences);
    if (source === "auto" && serialized === lastSavedListingPreferencesRef.current) {
      return;
    }
    if (source === "manual") {
      setListingPreferenceStatus("\u6b63\u5728\u4fdd\u5b58\u4e0a\u67b6\u8bbe\u7f6e");
    }
    const result = await client.saveListingPreferences(preferences);
    lastSavedListingPreferencesRef.current = serializeListingPreferences(result.preferences);
    setListingPreferenceStatus(source === "manual"
      ? "\u4e0a\u67b6\u8bbe\u7f6e\u5df2\u4fdd\u5b58"
      : "\u4e0a\u67b6\u8bbe\u7f6e\u5df2\u81ea\u52a8\u4fdd\u5b58");
  };
  const ensureShopOperationOptions = async (externalShopId: string) => {
    const localShopId = localShopByExternalId.get(externalShopId)?.id;
    if (!localShopId || loadingShopOptions[localShopId] || warehousesByShopId[localShopId]) {
      return;
    }
    setLoadingShopOptions((current) => ({ ...current, [localShopId]: true }));
    try {
      const [warehouses, actionsRaw] = await Promise.all([
        api.listWarehouses(localShopId),
        api.listActions(localShopId).catch(() => ({ result: [] })),
      ]);
      setWarehousesByShopId((current) => ({ ...current, [localShopId]: warehouses }));
      setActionsByShopId((current) => ({ ...current, [localShopId]: normalizeActionOptions(actionsRaw) }));
    } finally {
      setLoadingShopOptions((current) => ({ ...current, [localShopId]: false }));
    }
  };

  const chooseUploadFiles = (files: FileList | null, source: UploadSource) => {
    const selectedFiles = Array.from(files ?? []);
    const imageFiles = selectedFiles.filter(isSupportedImageFile);
    const skipped = selectedFiles.length - imageFiles.length;
    setUploadFiles(imageFiles);
    setUploadSource(source);
    setUploadProgress(null);
    setUploadErrors([]);
    commitUploadTask(null);

    if (selectedFiles.length === 0) {
      return;
    }

    if (imageFiles.length === 0) {
      commitUploadTask(null);
      onMessage("请选择 PNG、JPG、JPEG 或 WebP 图片");
      return;
    }

    const sourceText = source === "folder" ? "文件夹" : "图片文件";
    const skippedText = skipped > 0 ? `，已跳过 ${skipped} 个非图片文件` : "";
    const nextPlan = createUploadPlan(imageFiles);
    const batchText = nextPlan.totalBatches > 1 ? `，将拆成 ${nextPlan.totalBatches} 批` : "";
    commitUploadTask(createUploadTaskSnapshot(imageFiles, source, nextPlan, "selected", `已选择 ${imageFiles.length} 张图片${skippedText}`));
    onMessage(`已选择${sourceText}：${imageFiles.length} 张图片${skippedText}${batchText}，单批最大 ${maxUploadBatchLabel}`);
  };

  const chooseLocalUploadFiles = async () => {
    setLocalUploadPicking(true);
    try {
      const paths = await api.pickImageFiles();
      const selection = await api.scanGalleryUploadFiles(paths);
      setLocalUploadSelection(selection);
      onMessage(`已选择 ${selection.count} 张图片，总大小 ${formatFileSize(selection.totalBytes)}`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalUploadPicking(false);
    }
  };

  const chooseLocalUploadFolder = async () => {
    setLocalUploadPicking(true);
    try {
      const folder = await api.pickDirectory();
      const selection = await api.scanGalleryUploadFiles([folder]);
      setLocalUploadSelection(selection);
      onMessage(`已选择文件夹，找到 ${selection.count} 张图片，总大小 ${formatFileSize(selection.totalBytes)}`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLocalUploadPicking(false);
    }
  };

  const startLocalUploadJob = async () => {
    if (!localUploadSelection || localUploadSelection.count === 0) {
      onMessage("请先选择要上传的图片");
      return;
    }
    if (!selectedProductImageRuleId) {
      onMessage("请先选择商品类型和图片比例");
      return;
    }
    try {
      if (localUploadExceedsStorage) {
        onMessage(`图库容量不足：剩余 ${formatFileSize(galleryStorageRemainingBytes)}，本次选择 ${formatFileSize(localUploadSelection.totalBytes)}`);
        return;
      }
      const job = await api.startGalleryUploadJob({
        cloudApiBaseUrl: cloudApiBaseUrl || "",
        paths: localUploadSelection.paths,
        sourceLabel: `${localUploadSelection.count} 张图片`,
        productImageRuleId: selectedProductImageRuleId,
      });
      onJobStarted?.(job);
      setGalleryUploadJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
      setLocalUploadSelection(null);
      onMessage("已创建后台上传任务，客户端会继续上传，切换页面不会中断。");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const uploadBatch = async () => {
    if (uploadFiles.length === 0) {
      onMessage("请先选择图片");
      return;
    }
    if (!selectedProductImageRuleId) {
      onMessage("请先选择商品类型和图片比例");
      return;
    }
    setLoading(true);
    const plan = createUploadPlan(uploadFiles);
    if (uploadExceedsStorage) {
      onMessage(`图库容量不足：剩余 ${formatFileSize(galleryStorageRemainingBytes)}，本次选择 ${formatFileSize(plan.totalBytes)}`);
      setLoading(false);
      return;
    }
    const batches = plan.batches;
    let uploaded = 0;
    let failed = 0;
    let processed = 0;
    const errors: UploadError[] = [];
    let task = createUploadTaskSnapshot(uploadFiles, uploadSource, plan, "running", `正在上传 0/${uploadFiles.length} 张图片`);
    task = {
      ...task,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      setUploadErrors([]);
      commitUploadTask(task);
      onMessage(`开始上传 ${uploadFiles.length} 张图片，共 ${batches.length} 批，总大小 ${formatFileSize(plan.totalBytes)}`);
      for (let index = 0; index < batches.length; index += 1) {
        const batch = batches[index];
        const batchBytes = batch.reduce((sum, file) => sum + fileSize(file), 0);
        const batchTooLargeMessage = batchBytes > maxUploadRequestBytes
          ? `第 ${index + 1} 批大小 ${formatFileSize(batchBytes)}，超过单批上限 ${formatFileSize(maxUploadRequestBytes)}，请减少单批文件数量后重试`
          : "";
        setUploadProgress({
          currentBatch: index + 1,
          totalBatches: batches.length,
          uploaded,
          failed,
          totalFiles: uploadFiles.length,
          currentBatchFiles: batch.length,
          currentBatchBytes: batchBytes,
          totalBytes: plan.totalBytes,
        });
        task = {
          ...task,
          status: "running",
          currentBatch: index + 1,
          currentBatchFiles: batch.length,
          currentBatchBytes: batchBytes,
          uploaded,
          failed,
          processed,
          message: `正在上传第 ${index + 1}/${batches.length} 批，已成功 ${uploaded} 张`,
          updatedAt: new Date().toISOString(),
        };
        commitUploadTask(task);
        const handleServerTaskProgress = (serverTask: GalleryUploadTask) => {
          const nextUploaded = uploaded + serverTask.uploaded;
          const nextFailed = failed + serverTask.failed;
          const nextProcessed = processed + serverTask.processed;
          setUploadProgress({
            currentBatch: index + 1,
            totalBatches: batches.length,
            uploaded: nextUploaded,
            failed: nextFailed,
            totalFiles: uploadFiles.length,
            currentBatchFiles: batch.length,
            currentBatchBytes: batchBytes,
            totalBytes: plan.totalBytes,
          });
          task = {
            ...task,
            status: "running",
            currentBatch: index + 1,
            currentBatchFiles: batch.length,
            currentBatchBytes: batchBytes,
            uploaded: nextUploaded,
            failed: nextFailed,
            processed: nextProcessed,
            errors: [...errors, ...normalizeUploadErrors(serverTask.errors)].slice(-20),
            message: serverTask.message
              ? `第 ${index + 1}/${batches.length} 批：${serverTask.message}`
              : `正在上传第 ${index + 1}/${batches.length} 批，已处理 ${nextProcessed}/${uploadFiles.length} 张`,
            updatedAt: new Date().toISOString(),
          };
          commitUploadTask(task);
        };
        const result = batchTooLargeMessage
          ? createUploadFailureResult(batch, new Error(batchTooLargeMessage))
          : await uploadAssetsWithFallback((files) => client.uploadAssets(files, handleServerTaskProgress, selectedProductImageRuleId), batch);
        uploaded += result.uploaded;
        failed += result.failed;
        processed += result.uploaded + result.failed;
        errors.push(...normalizeUploadErrors(result.errors));
        setUploadErrors(errors);
        setUploadProgress({
          currentBatch: index + 1,
          totalBatches: batches.length,
          uploaded,
          failed,
          totalFiles: uploadFiles.length,
          currentBatchFiles: batch.length,
          currentBatchBytes: batchBytes,
          totalBytes: plan.totalBytes,
        });
        task = {
          ...task,
          status: "running",
          currentBatch: index + 1,
          currentBatchFiles: batch.length,
          currentBatchBytes: batchBytes,
          uploaded,
          failed,
          processed,
          errors: errors.slice(-20),
          message: `已完成第 ${index + 1}/${batches.length} 批，成功 ${uploaded} 张，失败 ${failed} 张`,
          updatedAt: new Date().toISOString(),
        };
        commitUploadTask(task);
      }
      setUploadFiles([]);
      if (tab !== "upload") {
        await loadAssets(1);
      }
      const sourceText = uploadSource === "folder" ? "文件夹上传" : "图片上传";
      const finalTask: UploadTaskSnapshot = {
        ...task,
        status: failed > 0 ? "partial" : "succeeded",
        uploaded,
        failed,
        processed,
        errors: errors.slice(-20),
        message: failed > 0 ? `上传完成：成功 ${uploaded} 张，失败 ${failed} 张` : `上传完成：成功 ${uploaded} 张`,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      finishUploadTask(finalTask);
      if (failed > 0) {
        onMessage(`${sourceText}完成：成功 ${uploaded} 张，失败 ${failed} 张，可查看失败记录后重试`);
      } else {
        onMessage(`${sourceText}完成：成功 ${uploaded} 张`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const remaining = Math.max(0, uploadFiles.length - processed);
      const nextErrors = [
        ...errors,
        { filename: "本批上传请求", message },
      ];
      setUploadErrors(nextErrors);
      setUploadProgress({
        currentBatch: Math.min(batches.length, Math.max(1, processed === 0 ? 1 : Math.ceil(processed / maxUploadBatchSize))),
        totalBatches: batches.length,
        uploaded,
        failed,
        totalFiles: uploadFiles.length,
        totalBytes: plan.totalBytes,
      });
      const finalTask: UploadTaskSnapshot = {
        ...task,
        status: uploaded > 0 ? "partial" : "failed",
        uploaded,
        failed,
        processed,
        errors: nextErrors.slice(-20),
        message: `上传中断：已成功 ${uploaded} 张，剩余 ${remaining} 张。${message}`,
        finishedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      finishUploadTask(finalTask);
      onMessage(`上传中断：已成功 ${uploaded} 张，剩余 ${remaining} 张。${message}`);
    } finally {
      setLoading(false);
    }
  };

  const markAssetUsed = async (asset: CloudAsset) => {
    if (tab === "featured") {
      onMessage("精品图库里的图片不能直接标记为已使用，请先复制到自己的图库后再处理。");
      return;
    }
    if (!selectedShopId) {
      onMessage("请先选择店铺");
      return;
    }
    setLoading(true);
    try {
      await client.markAssetUsed(asset.id, selectedShopId);
      await loadAssets(page);
      onMessage(`已将 ${asset.sku} 标记为已使用，会从当前待上传列表隐藏。`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const deleteAsset = async (asset: CloudAsset) => {
    if (deleteConfirmAssetId !== asset.id) {
      setDeleteConfirmAssetId(asset.id);
      onMessage(`再次点击删除可将 ${asset.sku} 从当前页面隐藏。`);
      return;
    }
    setLoading(true);
    try {
      await client.deleteAsset(asset.id);
      setAssets((current) => current.filter((item) => item.id !== asset.id));
      setSelectedAssetIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
      setTotal((current) => Math.max(0, current - 1));
      setDeleteConfirmAssetId("");
      onMessage(`已删除 ${asset.sku}。`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const deleteSelectedAssets = async () => {
    if (selectedDeletableAssets.length === 0) {
      onMessage("请先选择要删除的图片");
      return;
    }
    if (!bulkDeleteConfirm) {
      setBulkDeleteConfirm(true);
      setDeleteConfirmAssetId("");
      onMessage(`再次点击批量删除，可删除 ${selectedDeletableAssets.length} 张图片。`);
      return;
    }

    setLoading(true);
    const deletedIds = new Set<string>();
    const failedItems: UploadError[] = [];
    try {
      for (const asset of selectedDeletableAssets) {
        try {
          await client.deleteAsset(asset.id);
          deletedIds.add(asset.id);
        } catch (error) {
          failedItems.push({
            filename: asset.sku,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (deletedIds.size > 0) {
        setAssets((current) => current.filter((item) => !deletedIds.has(item.id)));
        setSelectedAssetIds((current) => {
          const next = new Set(current);
          for (const assetId of deletedIds) {
            next.delete(assetId);
          }
          return next;
        });
        setTotal((current) => Math.max(0, current - deletedIds.size));
      }
      setDeleteConfirmAssetId("");
      setBulkDeleteConfirm(false);
      if (failedItems.length > 0) {
        setUploadErrors((current) => [...failedItems, ...current].slice(0, 12));
      }
      onMessage(`批量删除完成：成功 ${deletedIds.size} 张，失败 ${failedItems.length} 张`);
    } finally {
      setLoading(false);
    }
  };

  const renderSelectedMockup = async (asset: CloudAsset) => {
    if (tab !== "pending") {
      onMessage("有图片删除失败，请稍后重试或查看错误信息。");
      return;
    }
    setRenderingAssetId(asset.id);
    setLoading(true);
    setMockupErrors([]);
    setMockupNotice({
      type: "info",
      message: `正在根据 ${asset.sku} 生成${currentMockupTemplateName}套图，请稍等。`,
    });
    try {
      const result = await renderMockup(asset.id, selectedMockupTemplate);
      applyMockupResult(asset, result.assets);
      const firstAsset = result.assets[0];
      const sizeText = firstAsset ? `，尺寸 ${firstAsset.width}x${firstAsset.height}` : "";
      const message = `${result.template.name}已为 ${asset.sku} 生成 ${result.generated} 张效果图${sizeText}`;
      setMockupNotice({ type: "success", message });
      onMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMockupErrors([{ filename: asset.sku, message }]);
      setMockupNotice({ type: "error", message: `${asset.sku} 套图失败：${message}` });
      onMessage(message);
    } finally {
      setRenderingAssetId("");
      setLoading(false);
    }
  };

  const renderMockup = (assetId: string, templateId: string) => {
    const asset = assets.find((item) => item.id === assetId) ?? previewAsset;
    if (asset?.id === assetId) {
      return renderMockupWithFallbacks(asset, templateId);
    }
    return renderMockupInCloud(assetId, templateId);
  };

  const renderMockupWithFallbacks = async (asset: CloudAsset, templateId: string) => {
    try {
      const result = await renderMockupInLocalAssistant(asset, templateId);
      onMessage(`${asset.sku} 已由本地助手后台生成套图并上传云端。`);
      return result;
    } catch (assistantError) {
      onMessage(`本地助手后台套图暂不可用，已切换浏览器本机生成：${formatLocalMockupError(assistantError)}`);
    }
    try {
      const result = await renderMockupLocallyAndUpload({ client, templateId, asset });
      onMessage(`${asset.sku} 已使用浏览器本机生成套图并上传云端。`);
      return result;
    } catch (localError) {
      onMessage(`浏览器本机套图失败，已自动切换云端生成：${formatLocalMockupError(localError)}`);
      return renderMockupInCloud(asset.id, templateId);
    }
  };

  const renderMockupInLocalAssistant = async (asset: CloudAsset, templateId: string) => {
    const result = await renderMockupsInLocalAssistant([asset], templateId, 1);
    const item = result.items.find((entry) => entry.sourceAssetId === asset.id);
    const template = mockupTemplates.find((item) => item.id === templateId) ?? currentMockupTemplate;
    if (!item?.ok || !Array.isArray(item.assets) || item.assets.length === 0) {
      throw new Error(item?.error || "本地助手后台套图没有返回结果");
    }
    return {
      ok: true,
      sourceAsset: {
        id: asset.id,
        sku: asset.sku,
        sourceFilename: asset.sourceFilename,
      },
      template: {
        id: result.templateId,
        name: result.templateName,
        sceneCount: item.assets.length,
        outputWidth: template?.outputWidth ?? item.assets[0]?.width ?? 0,
        outputHeight: template?.outputHeight ?? item.assets[0]?.height ?? 0,
      },
      generated: item.assets.length,
      assets: item.assets,
    };
  };

  const renderMockupsInLocalAssistant = async (
    targetAssets: CloudAsset[],
    templateId: string,
    maxWorkers = mockupBatchConcurrency,
    options: LocalMockupWaitOptions = {},
  ): Promise<LocalMockupRenderResult> => {
    const template = mockupTemplates.find((item) => item.id === templateId) ?? currentMockupTemplate;
    let job: JobSummary | undefined;
    if (options.jobId) {
      const existingJob = (await api.listJobs()).find((item) => item.id === options.jobId);
      if (existingJob && (existingJob.status === "queued" || existingJob.status === "running")) {
        job = existingJob;
      }
    }
    if (!job) {
      job = await api.startLocalMockupRender({
        cloudApiBaseUrl,
        cloudAuthToken: getCloudToken() || undefined,
        templateId,
        templateName: template?.name,
        assets: targetAssets.map((asset) => ({
          id: asset.id,
          sku: asset.sku,
          sourceFilename: asset.sourceFilename,
          publicUrl: asset.publicUrl,
        })),
        maxWorkers,
      });
      onJobStarted?.(job);
      options.onJobStarted?.(job);
    }
    options.onProgress?.(job);
    return waitForLocalMockupResult(job.id, options.onProgress);
  };

  const waitForLocalMockupResult = async (
    jobId: string,
    onProgress?: (job: JobSummary) => void,
  ): Promise<LocalMockupRenderResult> => {
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      const jobs = await api.listJobs();
      const job = jobs.find((item) => item.id === jobId);
      if (!job) {
        throw new Error("本地助手套图任务不存在或已被清理");
      }
      onProgress?.(job);
      if (job.status === "succeeded") {
        if (!job.resultPath && !job.outputPath) {
          throw new Error("本地助手套图任务完成，但没有返回结果文件");
        }
        return api.readLocalMockupResult(job.resultPath || job.outputPath!);
      }
      if (job.status === "failed" || job.status === "cancelled") {
        throw new Error(job.lastError || job.error || "本地助手套图任务失败");
      }
      await delay(1000);
    }
    throw new Error("本地助手套图任务等待超时");
  };

  const renderMockupInCloud = (assetId: string, templateId: string) => {
    return client.renderMockup(templateId, assetId).catch((error) => {
      if (templateId === "fangjin") {
        return client.renderFangjinMockup(assetId);
      }
      throw error;
    });
  };

  const renderSelectedAssetsMockups = async (targets = selectedAssetsWithoutCurrentMockup, force = false) => {
    if (tab !== "pending") {
      onMessage("恢复上架任务缺少商品类型和图片比例。");
      return;
    }
    if (targets.length === 0) {
      const selectedText = selectedAssets.length > 0 ? "??????????????" : "?????????????";
      onMessage(`${selectedText}需要重新生成时，请在单张图片上点击重新生成。`);
      return;
    }

    setLoading(true);
    setMockupErrors([]);
    setMockupNotice({
      type: "info",
      message: force
        ? `正在覆盖重新生成 ${targets.length} 个货号的${currentMockupTemplateName}套图。`
        : `?????? ${targets.length} ??? ${currentMockupTemplateName} ????`,
    });
    let generated = 0;
    let failed = 0;
    const successIds = new Set<string>();
    const errors: UploadError[] = [];
    try {
      let handledByAssistant = false;
      try {
        const result = await renderMockupsInLocalAssistant(targets, selectedMockupTemplate);
        handledByAssistant = true;
        for (const item of Array.isArray(result.items) ? result.items : []) {
          const asset = targets.find((target) => target.id === item.sourceAssetId);
          if (item.ok && asset && Array.isArray(item.assets)) {
            applyMockupResult(asset, item.assets);
            generated += item.assets.length;
            successIds.add(asset.id);
          } else {
            failed += 1;
            errors.push({
              filename: item.sourceSku,
              message: item.error || "本地助手后台套图失败",
            });
          }
          setMockupErrors([...errors]);
          setBatchMockupProgress({
            total: targets.length,
            done: successIds.size + failed,
            failed,
            currentSku: item.sourceSku,
          });
        }
        onMessage(`本地助手后台套图完成：成${successIds.size} 个，失败 ${failed} 个。`);
      } catch (assistantError) {
        onMessage(`本地助手后台批量套图不可用，已切换浏览器本机并发${formatLocalMockupError(assistantError)}`);
      }
      if (!handledByAssistant) {
        await runWithConcurrency(targets, mockupBatchConcurrency, async (asset) => {
          setRenderingAssetId(asset.id);
          setBatchMockupProgress({
            total: targets.length,
            done: successIds.size + failed,
            failed,
            currentSku: asset.sku,
          });
          try {
            const result = await renderMockup(asset.id, selectedMockupTemplate);
            applyMockupResult(asset, result.assets);
            generated += result.generated;
            successIds.add(asset.id);
          } catch (error) {
            failed += 1;
            errors.push({
              filename: asset.sku,
              message: error instanceof Error ? error.message : String(error),
            });
            setMockupErrors([...errors]);
          }
          setBatchMockupProgress({
            total: targets.length,
            done: successIds.size + failed,
            failed,
            currentSku: asset.sku,
          });
        });
      }
      const selectedTargetIds = new Set(targets.map((asset) => asset.id));
      const skippedSelectedCount = selectedAssets.filter((asset) => !selectedTargetIds.has(asset.id)).length;
      const skippedText = !force && skippedSelectedCount > 0 ? `，已跳过 ${skippedSelectedCount} 个已套当前样机的货号` : "";
      const actionText = force ? "覆盖重新生成" : "批量套图";
      const message = `${actionText}完成：成${successIds.size} 个货号，生成 ${generated} 张效果图，失${failed} ${skippedText}。`;
      setMockupNotice({ type: failed > 0 ? "error" : "success", message });
      onMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setMockupNotice({ type: "error", message: `批量套图中断${message}` });
      onMessage(message);
    } finally {
      setRenderingAssetId("");
      setBatchMockupProgress(null);
      setLoading(false);
    }
  };

  const applyMockupResult = (asset: CloudAsset, generatedAssets: CloudMockupAsset[]) => {
    setAssets((current) => current.map((item) => item.id === asset.id ? {
      ...item,
      mockupResults: mergeMockupResults(item.mockupResults, generatedAssets),
    } : item));
    updateLocalProcessingAssets((current) => current.map((item) => item.id === asset.id ? {
      ...item,
      mockupResults: mergeMockupResults(item.mockupResults, generatedAssets),
    } : item));
    setPreviewAsset((current) => current?.id === asset.id ? {
      ...current,
      mockupResults: mergeMockupResults(current.mockupResults, generatedAssets),
    } : current);
  };

  const addLocalProcessingAssets = (items: CloudAsset[]) => {
    if (items.length === 0) {
      return;
    }
    updateLocalProcessingAssets((current) => dedupeAssetsById([...items, ...current]));
  };

  const removeLocalProcessingAssets = (assetIds: Iterable<string>) => {
    const idSet = new Set(assetIds);
    if (idSet.size === 0) {
      return;
    }
    updateLocalProcessingAssets((current) => current.filter((asset) => !idSet.has(asset.id)));
  };

  const updateLocalProcessingAssets = (updater: (current: CloudAsset[]) => CloudAsset[]) => {
    setLocalProcessingAssets((current) => {
      const next = updater(current);
      writeStoredLocalProcessingAssets(cloudApiBaseUrl, next);
      return next;
    });
  };

  const updateLocalPreparationTasks = (updater: (current: LocalPreparationTask[]) => LocalPreparationTask[]) => {
    setLocalPreparationTasks((current) => {
      const next = updater(current);
      writeStoredLocalPreparationTasks(cloudApiBaseUrl, next);
      return next;
    });
  };

  const markLocalPreparationTask = (
    taskId: string,
    patch: Partial<Pick<LocalPreparationTask, "status" | "error" | "localMockupJobId" | "progress">>,
  ) => {
    updateLocalPreparationTasks((current) => current.map((task) => (
      task.id === taskId
        ? { ...task, ...patch, updatedAt: Date.now() }
        : task
    )));
  };

  const markLocalPreparationProgress = (
    taskId: string | undefined,
    progress: Partial<Omit<LocalPreparationProgress, "updatedAt">>,
  ) => {
    if (!taskId) {
      return;
    }
    updateLocalPreparationTasks((current) => current.map((task) => {
      if (task.id !== taskId) {
        return task;
      }
      const total = progress.total ?? task.progress?.total ?? task.assetIds.length;
      const done = progress.done ?? task.progress?.done ?? 0;
      const failed = progress.failed ?? task.progress?.failed ?? 0;
      const nextProgress: LocalPreparationProgress = {
        stage: progress.stage ?? task.progress?.stage ?? "queued",
        total,
        done,
        failed,
        percent: progress.percent ?? task.progress?.percent ?? progressPercent(done, total),
        currentSku: progress.currentSku ?? task.progress?.currentSku,
        message: progress.message ?? task.progress?.message,
        updatedAt: Date.now(),
      };
      return { ...task, progress: nextProgress, updatedAt: Date.now() };
    }));
  };

  const createAutoListingPreparationContext = (targetAssets: CloudAsset[]): AutoListingPreparationContext | null => {
    const ruleById = new Map(productImageRules.map((rule) => [rule.id, rule]));
    const productImageRule = targetAssets.length > 0
      ? resolveProductImageRuleForAsset(targetAssets[0], ruleById, productImageRules)
      : selectedProductImageRule;
    if (!productImageRule || activeShopListingConfigs.length === 0) {
      return null;
    }
    const draftsByAssetId: Record<string, ListingAssetDraft> = {};
    targetAssets.forEach((asset, index) => {
      const fallbackShopId = activeShopListingConfigs[index % activeShopListingConfigs.length].externalShopId;
      draftsByAssetId[asset.id] = listingDrafts[asset.id] ?? createListingDraftFromAsset(asset, fallbackShopId);
    });
    const now = new Date().toISOString();
    return {
      runId: crypto.randomUUID(),
      ratioFamily: ratioFamilyForAspectRatio(productImageRule.aspectRatio) as CloudAsset["ratioFamily"],
      productImageRuleId: productImageRule.id,
      productType: productImageRule.productType,
      aspectRatio: productImageRule.aspectRatio,
      mockupTemplateId: selectedMockupTemplate,
      mockupTemplateName: currentMockupTemplateName,
      titlePromptTemplateId: selectedTitlePromptId,
      titlePromptTemplateName: titlePromptName,
      titlePrompt,
      shopListingConfigs: activeShopListingConfigs.map((config) => ({ ...config })),
      shopConfigSnapshots: [],
      draftsByAssetId,
      createdAt: now,
    };
  };
  const createLocalPreparationTask = (targetAssets: CloudAsset[], context: AutoListingPreparationContext) => {
    const existingTask = localPreparationTasks.find((task) => (
      task.status !== "prepared"
      && task.assetIds.length === targetAssets.length
      && task.assetIds.every((assetId) => targetAssets.some((asset) => asset.id === assetId))
    ));
    if (existingTask) {
      return existingTask.id;
    }
    const now = Date.now();
    const task: LocalPreparationTask = {
      id: context.runId,
      assetIds: targetAssets.map((asset) => asset.id),
      status: "queued",
      context,
      progress: {
        stage: "queued",
        total: targetAssets.length,
        done: 0,
        failed: 0,
        percent: 0,
        message: "已进入本地后台队列，等待套图",
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    };
    updateLocalPreparationTasks((current) => [...current.filter((item) => item.id !== task.id), task]);
    return task.id;
  };

  const enqueueAutoListingPreparation = (targetAssets: CloudAsset[]) => {
    const sourceAssets = targetAssets.filter((asset) => !asset.listingStatus);
    const context = createAutoListingPreparationContext(sourceAssets);
    if (!context?.productImageRuleId || sourceAssets.length === 0) {
      onMessage("请先选择已维护的商品类型、图片比例和店铺配置。");
      return null;
    }
    const taskId = createLocalPreparationTask(sourceAssets, context);
    addLocalProcessingAssets(sourceAssets);
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      sourceAssets.forEach((asset) => next.delete(asset.id));
      return next;
    });
    markLocalPreparationTask(taskId, { status: "queued", error: undefined });
    markLocalPreparationProgress(taskId, {
      stage: "queued",
      total: sourceAssets.length,
      done: 0,
      failed: 0,
      percent: 0,
      message: "?????????????????",
    });
    onMessage(`已创建上架任务：${sourceAssets.length} 个商品。系统将按创建顺序逐个任务执行。`);
    void loadAssets(page, "pending", {
      silent: true,
      excludeAssetIdsOverride: [...new Set([...localProcessingAssetIds, ...sourceAssets.map((asset) => asset.id)])],
    });
    return taskId;
  };

  const saveTitlePrompt = async () => {
    if (!titlePromptName.trim() || !titlePrompt.trim()) {
      onMessage("?????????????????");
      return;
    }
    setLoading(true);
    try {
      const result = await client.saveTitlePromptTemplate({
        id: isUuid(selectedTitlePromptId) ? selectedTitlePromptId : undefined,
        name: titlePromptName.trim(),
        prompt: titlePrompt.trim(),
      });
      setSelectedTitlePromptId(result.template.id);
      setTitlePromptName(result.template.name);
      setTitlePrompt(result.template.prompt);
      setTitlePromptTemplates((current) => upsertById(current, result.template));
      onMessage(`标题提示词模板已保存${result.template.name}`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const selectTitlePromptTemplate = (id: string) => {
    setSelectedTitlePromptId(id);
    const template = titlePromptTemplates.find((item) => item.id === id);
    if (template) {
      setTitlePromptName(template.name);
      setTitlePrompt(template.prompt);
    }
  };

  const addListingShop = () => {
    const used = new Set(shopListingConfigs.map((config) => config.externalShopId));
    const nextShop = listingShopOptions.find((shop) => !used.has(shop.id));
    if (!nextShop) {
      onMessage("???????????????????");
      return;
    }
    setShopListingConfigs((current) => {
      const sourceConfig = current[current.length - 1];
      return [...current, sourceConfig
        ? cloneShopListingConfigForShop(sourceConfig, nextShop.id, nextShop.name)
        : createDefaultShopListingConfig(nextShop.id, nextShop.name)];
    });
  };

  const removeListingShop = (externalShopId: string) => {
    setShopListingConfigs((current) => current.filter((config) => config.externalShopId !== externalShopId));
    setListingDrafts((current) => {
      const next = { ...current };
      for (const [assetId, draft] of Object.entries(next)) {
        if (draft.externalShopId === externalShopId) {
          delete next[assetId];
        }
      }
      return next;
    });
  };

  const updateListingShopConfig = (externalShopId: string, patch: Partial<ShopListingConfig>) => {
    setShopListingConfigs((current) => {
      const next = current.map((config) => (
        config.externalShopId === externalShopId ? { ...config, ...patch } : config
      ));
      return next;
    });
  };

  const changeListingShop = (currentExternalShopId: string, nextExternalShopId: string) => {
    const nextShop = listingShopOptions.find((shop) => shop.id === nextExternalShopId);
    setShopListingConfigs((current) => current.map((config) => (
      config.externalShopId === currentExternalShopId
        ? cloneShopListingConfigForShop(config, nextExternalShopId, nextShop?.name ?? "店铺")
        : config
    )));
    setListingDrafts((current) => {
      const next = { ...current };
      for (const [assetId, draft] of Object.entries(next)) {
        if (draft.externalShopId === currentExternalShopId) {
          next[assetId] = { ...draft, externalShopId: nextExternalShopId };
        }
      }
      return next;
    });
  };

  const selectProductTemplateForShop = (externalShopId: string, templateId: string) => {
    const template = productTemplates.find((item) => item.id === templateId);
    updateListingShopConfig(externalShopId, {
      productTemplateId: templateId,
      productTemplateName: template?.name ?? "",
      newTemplateName: template?.name ?? "",
      categoryLabel: template?.categoryLabel ?? "",
      productTemplateShared: template ? Boolean(template.shared || template.externalShopId === SHARED_PRODUCT_TEMPLATE_SHOP_ID) : true,
    });
  };

  const saveProductTemplateForShop = async (config: ShopListingConfig) => {
    const name = (config.newTemplateName || config.productTemplateName).trim();
    if (!name) {
      onMessage("???????????");
      return;
    }
    setLoading(true);
    try {
      const result = await client.saveProductTemplate({
        externalShopId: config.productTemplateShared ? undefined : config.externalShopId,
        shared: config.productTemplateShared,
        id: config.productTemplateId || undefined,
        name,
        categoryLabel: config.categoryLabel.trim() || undefined,
      });
      const templatePatch = {
        productTemplateId: result.template.id,
        productTemplateName: result.template.name,
        newTemplateName: result.template.name,
        categoryLabel: result.template.categoryLabel ?? "",
        productTemplateShared: Boolean(result.template.shared || result.template.externalShopId === SHARED_PRODUCT_TEMPLATE_SHOP_ID),
      };
      const latestPreferences = listingPreferencesSnapshotRef.current;
      const updatedPreferences: CloudListingPreferences = {
        ...latestPreferences,
        shopListingConfigs: (latestPreferences.shopListingConfigs ?? []).map((item) => (
          item.externalShopId === config.externalShopId ? { ...item, ...templatePatch } : item
        )),
      };
      listingPreferencesSnapshotRef.current = updatedPreferences;
      setProductTemplates((current) => upsertById(current, result.template));
      setShopListingConfigs((current) => current.map((item) => (
        item.externalShopId === config.externalShopId ? { ...item, ...templatePatch } : item
      )));
      await saveListingPreferences("auto", updatedPreferences);
      onMessage(`商品模板已保存：${result.template.shopName} / ${result.template.name}`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const updateListingDraft = (assetId: string, patch: Partial<ListingAssetDraft>) => {
    setListingDrafts((current) => {
      const existing = current[assetId] ?? createDefaultListingDraft(activeShopListingConfigs[0]?.externalShopId || "");
      return {
        ...current,
        [assetId]: { ...existing, ...patch },
      };
    });
  };

  const applyGeneratedTitle = (
    assetId: string,
    title: string,
    imageAssetId: string,
    prompt: string,
    updatedAt?: string | null,
  ) => {
    const patch = {
      generatedTitle: title,
      generatedTitleImageAssetId: imageAssetId,
      generatedTitlePrompt: prompt,
      generatedTitleUpdatedAt: updatedAt || new Date().toISOString(),
    };
    setAssets((current) => current.map((item) => item.id === assetId ? { ...item, ...patch } : item));
    updateLocalProcessingAssets((current) => current.map((item) => item.id === assetId ? { ...item, ...patch } : item));
    updateLocalPreparationTasks((current) => current.map((task) => {
      if (!task.assetIds.includes(assetId)) {
        return task;
      }
      const existingDraft = task.context.draftsByAssetId[assetId] ?? createDefaultListingDraft(task.context.shopListingConfigs[0]?.externalShopId || "");
      return {
        ...task,
        context: {
          ...task.context,
          draftsByAssetId: {
            ...task.context.draftsByAssetId,
            [assetId]: {
              ...existingDraft,
              title,
              titleStatus: "done",
              titleError: undefined,
            },
          },
        },
        updatedAt: Date.now(),
      };
    }));
    setPreviewAsset((current) => current?.id === assetId ? { ...current, ...patch } : current);
  };

  const generateTitleForAsset = async (asset: CloudAsset, imageAssetId?: string, context?: AutoListingPreparationContext) => {
    const templateId = context?.mockupTemplateId ?? selectedMockupTemplate;
    const firstMockup = imageAssetId ? { id: imageAssetId } : mockupResultsForDisplay(asset, templateId)[0];
    const existingTitle = assetDisplayTitle(asset, context?.draftsByAssetId[asset.id] ?? listingDrafts[asset.id]);
    if (existingTitle) {
      updateListingDraft(asset.id, { title: existingTitle, titleStatus: "done", titleError: undefined });
      return existingTitle;
    }
    if (!firstMockup?.id) {
      onMessage(`请先${asset.sku} 生成当前样机套图，再生成标题。`);
      return "";
    }
    updateListingDraft(asset.id, { titleStatus: "generating", titleError: undefined });
    try {
      const prompt = context?.titlePrompt?.trim() || titlePrompt.trim() || defaultTitlePrompt;
      const result = await client.generateListingTitle({
        sourceAssetId: asset.id,
        imageAssetId: firstMockup.id,
        prompt,
      });
      const savedTitle = result.asset?.generatedTitle || result.title;
      updateListingDraft(asset.id, {
        title: savedTitle,
        titleStatus: "done",
        titleError: undefined,
      });
      applyGeneratedTitle(
        asset.id,
        savedTitle,
        result.asset?.generatedTitleImageAssetId || result.imageAssetId,
        result.asset?.generatedTitlePrompt || prompt,
        result.asset?.generatedTitleUpdatedAt,
      );
      return savedTitle;
    } catch (error) {
      const message = formatTitleGenerationError(error);
      updateListingDraft(asset.id, { titleStatus: "error", titleError: message });
      return "";
    }
  };

  const generateTitlesForSelectedAssets = async () => {
    const targets = [...selectedListingReadyAssets];
    if (targets.length === 0) {
      onMessage("?????????????????????");
      return;
    }
    addLocalProcessingAssets(targets);
    setLoading(true);
    setListingProgress({ stage: "生成标题", total: targets.length, done: 0, failed: 0 });
    let done = 0;
    let failed = 0;
    try {
      await runWithConcurrency(targets, titleBatchConcurrency, async (asset) => {
        setListingProgress({ stage: "生成标题", total: targets.length, done, failed, currentSku: asset.sku });
        const title = await generateTitleForAsset(asset);
        if (!title) {
          failed += 1;
        }
        done += 1;
        setListingProgress({ stage: "生成标题", total: targets.length, done, failed, currentSku: asset.sku });
      });
      onMessage(`标题生成完成：成${targets.length - failed} 个，失败 ${failed} 个。`);
    } finally {
      setListingProgress(null);
      setLoading(false);
    }
  };

  const prepareListingBatch = async () => {
    await prepareListingBatchFromTargets(selectedListingReadyAssets);
  };

  const runOneClickListingForSelectedAssets = async () => {
    if (selectedAssets.length === 0) {
      onMessage("请先选择需要上架的图片。");
      return;
    }
    enqueueAutoListingPreparation(selectedAssets);
  };

  const runOneClickListingForCurrentPage = async () => {
    if (selectableAssets.length === 0) {
      onMessage("当前恢复任务没有可处理的商品。");
      return;
    }
    setSelectedAssetIds(new Set(selectableAssets.map((asset) => asset.id)));
    enqueueAutoListingPreparation(selectableAssets);
  };

  const prepareListingBatchFromTargets = async (
    targets: CloudAsset[],
    options: AutoListingPreparationOptions = {},
  ): Promise<CloudListingBatch | null> => {
    const preparationContext = options.context;
    const effectiveRatioFamily = preparationContext?.ratioFamily ?? ratioFamily;
    const effectiveProductImageRuleId = preparationContext?.productImageRuleId ?? selectedProductImageRuleId;
    const effectiveMockupTemplateId = preparationContext?.mockupTemplateId ?? selectedMockupTemplate;
    const effectiveMockupTemplateName = preparationContext?.mockupTemplateName ?? currentMockupTemplateName;
    const effectiveShopConfigs = preparationContext?.shopListingConfigs ?? activeShopListingConfigs;
    const effectiveDrafts = preparationContext?.draftsByAssetId ?? listingDrafts;
    if (tab !== "pending" && !options.allowNonPendingTab) {
      onMessage("只能在待上传或上传中页面恢复上架任务。");
      return null;
    }
    if (!effectiveProductImageRuleId) {
      onMessage("恢复上架任务缺少商品类型和图片比例。");
      return null;
    }
    if (effectiveShopConfigs.length === 0) {
      onMessage("恢复上架任务缺少店铺配置。");
      return null;
    }
    const incompleteShop = effectiveShopConfigs.find((config) => !(config.productTemplateId || config.productTemplateName || config.newTemplateName).trim());
    if (incompleteShop) {
      onMessage(`请先${selectedShopNameById.get(incompleteShop.externalShopId) ?? "店铺"} 选择或填写商品模板。`);
      return null;
    }
    if (targets.length === 0) {
      onMessage("当前恢复任务没有可处理的商品。");
      return null;
    }
    const shopsSynced = await ensureCloudShopsSynced(effectiveShopConfigs.map((config) => config.externalShopId), options.blocking === false ? "auto" : "manual");
    if (!shopsSynced) {
      return null;
    }
    const latestDailyStats = await loadTodayDailyListingStats({ silent: true });
    if (latestDailyStats) {
      const latestStatsByShopId = mapDailyListingStatsByShop(latestDailyStats, todayListingDate);
      const assignmentCounts = countListingAssignments(targets, effectiveDrafts, effectiveShopConfigs);
      const quotaWarnings = buildListingQuotaWarnings(
        buildListingQuotaSnapshots(effectiveShopConfigs, latestStatsByShopId, assignmentCounts),
        selectedShopNameById,
      );
      if (quotaWarnings.length > 0) {
        onMessage(`今日上架额度不足：${quotaWarnings.join("；")}`);
        return null;
      }
    } else {
      onMessage("恢复任务缺少有效的商品图片规则，已停止恢复以保护数据一致性。");
    }

    const shouldBlockUi = options.blocking !== false;
    addLocalProcessingAssets(targets);
    if (shouldBlockUi) {
      setLoading(true);
    }
    setListingProgress({ stage: "生成上架包", total: targets.length, done: 0, failed: 0 });
    markLocalPreparationProgress(options.preparationTaskId, {
      stage: "batch",
      total: targets.length,
      done: 0,
      failed: 0,
      percent: 0,
      message: "正在检查标题和套图结果",
    });
    try {
      const nextDrafts: Record<string, ListingAssetDraft> = { ...listingDrafts };
      for (let index = 0; index < targets.length; index += 1) {
        const asset = targets[index];
        const draft = effectiveDrafts[asset.id]
          ?? nextDrafts[asset.id]
          ?? createListingDraftFromAsset(asset, effectiveShopConfigs[index % effectiveShopConfigs.length].externalShopId);
        nextDrafts[asset.id] = draft;
      }
      const targetsNeedingTitles = targets.filter((asset) => !assetDisplayTitle(asset, nextDrafts[asset.id]));
      if (targetsNeedingTitles.length > 0) {
        const maxTitleAttempts = 3;
        let remaining = targetsNeedingTitles;
        for (let attempt = 1; attempt <= maxTitleAttempts && remaining.length > 0; attempt += 1) {
          let passDone = 0;
          const attemptTargets = remaining;
          setListingProgress({
            stage: attempt === 1 ? "生成标题" : `重试生成标题（第 ${attempt} 轮）`,
            total: targetsNeedingTitles.length,
            done: targetsNeedingTitles.length - attemptTargets.length,
            failed: attemptTargets.length,
          });
          markLocalPreparationProgress(options.preparationTaskId, {
            stage: "title",
            total: targetsNeedingTitles.length,
            done: targetsNeedingTitles.length - attemptTargets.length,
            failed: attemptTargets.length,
            percent: progressPercent(targetsNeedingTitles.length - attemptTargets.length, targetsNeedingTitles.length),
            message: attempt === 1 ? "正在并发生成标题" : `正在重试 ${attemptTargets.length} 个失败标题（${attempt} 轮）`,
          });
          await runWithConcurrency(attemptTargets, titleBatchConcurrency, async (asset) => {
            const draft = nextDrafts[asset.id] ?? createListingDraftFromAsset(asset, effectiveShopConfigs[0].externalShopId);
            const title = await generateTitleForAsset(asset, undefined, preparationContext);
            passDone += 1;
            nextDrafts[asset.id] = { ...draft, title, titleStatus: title ? "done" : "error" };
            const completed = targetsNeedingTitles.length - attemptTargets.length + passDone;
            setListingProgress({
              stage: attempt === 1 ? "生成标题" : `重试生成标题（第 ${attempt} 轮）`,
              total: targetsNeedingTitles.length,
              done: completed,
              failed: attemptTargets.length - passDone,
              currentSku: asset.sku,
            });
          });
          remaining = attemptTargets.filter((asset) => !assetDisplayTitle(asset, nextDrafts[asset.id]));
          if (remaining.length > 0 && attempt < maxTitleAttempts) {
            await delay(attempt * 1500);
          }
        }
        markLocalPreparationProgress(options.preparationTaskId, {
          stage: "title",
          total: targetsNeedingTitles.length,
          done: targetsNeedingTitles.length - remaining.length,
          failed: remaining.length,
          percent: 100,
          message: remaining.length > 0
            ? `标题生成完成，仍${remaining.length} 个失败，可在上传中继续执行`
            : "标题生成完成",
        });
      }
      setListingDrafts(nextDrafts);
      const missingTitles = targets.filter((asset) => !assetDisplayTitle(asset, nextDrafts[asset.id]));
      const batchTargets = targets.filter((asset) => assetDisplayTitle(asset, nextDrafts[asset.id]));
      if (batchTargets.length === 0) {
        onMessage(`本批 ${missingTitles.length} 个商品均未生成标题，已保留到上传中等待重试。`);
        return null;
      }
      if (missingTitles.length > 0) {
        onMessage(`本批有 ${missingTitles.length} 个商品标题生成失败；其余 ${batchTargets.length} 个商品继续上架，失败项保留重试。`);
      }

      if (!isMockupTemplateId(effectiveMockupTemplateId)) {
        onMessage("上架任务的样机 ID 无效，已停止本次恢复。");
        return null;
      }
      const invalidSource = batchTargets.find((asset) => !isUuid(asset.id));
      if (invalidSource) {
        onMessage(`${invalidSource.sku} 的商品 ID 无效，已停止本次恢复。`);
        return null;
      }
      const activeShopIds = new Set(effectiveShopConfigs.map((config) => config.externalShopId));
      const shopTargets: CreateListingBatchInput["shopTargets"] = effectiveShopConfigs.map((config) => ({
        externalShopId: config.externalShopId,
        id: isUuid(config.productTemplateId) ? config.productTemplateId : undefined,
        shared: config.productTemplateShared,
        name: trimText(config.productTemplateName || config.newTemplateName || `${selectedShopNameById.get(config.externalShopId) ?? "店铺"}商品模板`, 120),
        externalTemplateId: !isUuid(config.productTemplateId) && config.productTemplateId ? trimText(config.productTemplateId, 160) : undefined,
        categoryLabel: optionalTrimText(config.categoryLabel, 160),
      }));
      const invalidShopTarget = shopTargets.find((target) => !target.externalShopId.trim() || !target.name.trim());
      if (invalidShopTarget) {
        onMessage("??????????????????????????????");
        return null;
      }
      const shopTargetSnapshots = new Map<string, CloudListingConfigSnapshot>();
      for (const config of effectiveShopConfigs) {
        const localShop = localShopByExternalId.get(config.externalShopId);
        if (!localShop) {
          onMessage(`?????????????${selectedShopNameById.get(config.externalShopId) ?? config.externalShopId}`);
          return null;
        }
        const localTemplate = localProductTemplates.find((template) => template.id === config.localTemplateId);
        if (!localTemplate) {
          onMessage(`请先${selectedShopNameById.get(config.externalShopId) ?? "店铺"} 选择本地 Ozon 商品模板。`);
          return null;
        }
        shopTargetSnapshots.set(config.externalShopId, buildListingConfigSnapshot(config, {
          shopName: selectedShopNameById.get(config.externalShopId) ?? localShop.name,
          localShop,
          localTemplate,
        }));
      }
      const shopTargetsWithSnapshots = shopTargets.map((target) => ({
        ...target,
        configSnapshot: shopTargetSnapshots.get(target.externalShopId),
      }));
      const assetsForBatch: CreateListingBatchInput["assets"] = batchTargets.map((asset, index) => {
        const fallbackShopId = effectiveShopConfigs[index % effectiveShopConfigs.length].externalShopId;
        const draft = nextDrafts[asset.id] ?? createListingDraftFromAsset(asset, fallbackShopId);
        const externalShopId = activeShopIds.has(draft.externalShopId) ? draft.externalShopId : fallbackShopId;
        const title = assetDisplayTitle(asset, draft);
        if (draft.externalShopId !== externalShopId || (!draft.title.trim() && title)) {
          nextDrafts[asset.id] = {
            ...draft,
            externalShopId,
            title,
            titleStatus: title ? "done" : draft.titleStatus,
            titleError: title ? undefined : draft.titleError,
          };
        }
        return {
          sourceAssetId: asset.id,
          externalShopId,
          imageAssetIds: mockupResultsForDisplay(asset, effectiveMockupTemplateId)
            .map((item) => item.id)
            .filter(isUuid)
            .slice(0, 20),
          title: optionalTrimText(title, 500),
        };
      });
      setListingDrafts(nextDrafts);
      const assetWithoutImages = assetsForBatch.find((asset) => asset.imageAssetIds.length === 0);
      if (assetWithoutImages) {
        const source = targets.find((asset) => asset.id === assetWithoutImages.sourceAssetId);
        onMessage(`图片 ${source?.sku ?? assetWithoutImages.sourceAssetId} 没有可用的当前样机套图，请先重新生成套图。`);
        return null;
      }
      const assetWithoutTitle = assetsForBatch.find((asset) => !asset.title?.trim());
      if (assetWithoutTitle) {
        const source = targets.find((asset) => asset.id === assetWithoutTitle.sourceAssetId);
        onMessage(`图片 ${source?.sku ?? assetWithoutTitle.sourceAssetId} 没有可用标题，请先生成或手动填写标题。`);
        return null;
      }
      if (selectedTitlePromptId.trim() && !isUuid(selectedTitlePromptId)) {
        setSelectedTitlePromptId("");
        setListingPreferenceStatus("?????? ID ???????????????");
      }
      const result = await client.createListingBatch({
        ratioFamily: effectiveRatioFamily as CloudAsset["ratioFamily"],
        productImageRuleId: effectiveProductImageRuleId,
        mockupTemplateId: effectiveMockupTemplateId,
        mockupTemplateName: trimText(effectiveMockupTemplateName, 160) || "当前样机",
        titlePromptTemplateId: isUuid(preparationContext?.titlePromptTemplateId ?? selectedTitlePromptId) ? (preparationContext?.titlePromptTemplateId ?? selectedTitlePromptId) : undefined,
        titlePromptTemplateName: optionalTrimText(preparationContext?.titlePromptTemplateName ?? titlePromptName, 120),
        titlePrompt: optionalTrimText(preparationContext?.titlePrompt ?? titlePrompt, 8000),
        shopTargets: shopTargetsWithSnapshots,
        assets: assetsForBatch,
      });
      markLocalPreparationProgress(options.preparationTaskId, {
        stage: "batch",
        total: targets.length,
        done: batchTargets.length,
        failed: missingTitles.length,
        percent: 100,
        message: missingTitles.length > 0
          ? `已生成 ${batchTargets.length} 个上架商品，${missingTitles.length} 个标题失败项等待重试`
          : "上架包已生成",
      });
      setLastListingBatch(result.batch);
      setAssets((current) => current.map((asset) => attachListingStatusFromBatch(asset, result.batch)));
      updateLocalProcessingAssets((current) => (
        dedupeAssetsById([...targets, ...current]).map((asset) => attachListingStatusFromBatch(asset, result.batch))
      ));
      void loadTodayDailyListingStats({ silent: true });
      setSelectedAssetIds(new Set());
      if (!options.submitAfterPrepare) {
        removeLocalProcessingAssets(result.batch.imageSets.map((item) => item.sourceAssetId));
      }
      if (options.submitAfterPrepare) {
        await loadAssets(1, "processing", {
          silent: true,
          pageSizeOverride: defaultPageSizeForTab("processing", defaultPageSize),
        });
      } else {
        await loadAssets(page, tab, { silent: true });
      }
      onMessage(options.submitAfterPrepare
        ? `上架包已准备完成，正在启动自动上架：${result.batch.imageSets.length} 个商品，${result.batch.shopTargets.length} 个店铺。`
        : `上架包已准备完成${result.batch.imageSets.length} 个商品，${result.batch.shopTargets.length} 个店铺。`);
      return result.batch;
    } catch (error) {
      if (options.throwOnError) {
        throw error;
      }
      onMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setListingProgress(null);
      if (shouldBlockUi) {
        setLoading(false);
      }
    }
  };

  const runAutoListingPreparation = async () => {
    if (tab !== "pending") {
      onMessage("请在待处理图片页发起自动上架。");
      return;
    }
    if (selectedAssets.length === 0) {
      onMessage("请先选择需要上架的图片。");
      return;
    }
    enqueueAutoListingPreparation(selectedAssets);
  };

  const runAutoListingPreparationForAssets = async (
    targetAssets: CloudAsset[],
    options: AutoListingPreparationOptions = {},
  ) => {
    const preparationContext = options.context ?? createAutoListingPreparationContext(targetAssets);
    if (!preparationContext?.productImageRuleId) {
      onMessage("恢复任务缺少有效的商品图片规则，已停止恢复以保护数据一致性。");
      return null;
    }
    if (options.submitAfterPrepare && (!listingPreferencesLoaded || !localListingSetupLoaded)) {
      onMessage("上架设置尚未加载完成，暂不能恢复上传。");
      return null;
    }
    const preparationTaskId = options.preparationTaskId
      ?? (options.submitAfterPrepare ? createLocalPreparationTask(targetAssets.filter((asset) => !asset.listingStatus), preparationContext) : undefined);
    setActiveAutoListingRuns((current) => current + 1);
    if (preparationTaskId) {
      markLocalPreparationTask(preparationTaskId, { status: "running" });
      markLocalPreparationProgress(preparationTaskId, {
        stage: "queued",
        total: targetAssets.filter((asset) => !asset.listingStatus).length,
        done: 0,
        failed: 0,
        percent: 0,
        message: "正在启动本地后台处理",
      });
    }
    try {
      let sourceAssets = targetAssets.filter((asset) => !asset.listingStatus);
      if (sourceAssets.length === 0) {
        if (preparationTaskId) {
          markLocalPreparationTask(preparationTaskId, { status: "prepared", error: undefined });
        }
        return null;
      }
      const activeShopIds = new Set(preparationContext.shopListingConfigs.map((config) => config.externalShopId));
      const occupancyItems = sourceAssets.map((asset, index) => {
        const fallbackShopId = preparationContext.shopListingConfigs[index % preparationContext.shopListingConfigs.length].externalShopId;
        const draftShopId = preparationContext.draftsByAssetId[asset.id]?.externalShopId;
        return {
          sourceAssetId: asset.id,
          externalShopId: draftShopId && activeShopIds.has(draftShopId) ? draftShopId : fallbackShopId,
        };
      });
      const occupancy = client.checkListingOccupancy
        ? await client.checkListingOccupancy({ items: occupancyItems })
        : { ok: true, occupied: [] };
      const occupiedAssetIds = new Set(occupancy.occupied.map((item) => item.sourceAssetId));
      if (occupiedAssetIds.size > 0) {
        removeLocalProcessingAssets(occupiedAssetIds);
        sourceAssets = sourceAssets.filter((asset) => !occupiedAssetIds.has(asset.id));
        onMessage(`已跳${occupiedAssetIds.size} 个在对应店铺已选择或已上传的商品。`);
      }
      if (sourceAssets.length === 0) {
        if (preparationTaskId) {
          markLocalPreparationTask(preparationTaskId, { status: "prepared", error: undefined });
          markLocalPreparationProgress(preparationTaskId, {
            stage: "batch",
            total: occupiedAssetIds.size,
            done: occupiedAssetIds.size,
            failed: 0,
            percent: 100,
            message: "对应店铺中的商品均已处理，已结束重复任务",
          });
        }
        return null;
      }
      const sourceAssetIds = sourceAssets.map((asset) => asset.id);
            addLocalProcessingAssets(sourceAssets);
      const nextLocalProcessingAssetIds = [...new Set([...localProcessingAssetIds, ...sourceAssetIds])];
      setSelectedAssetIds((current) => {
        const next = new Set(current);
        sourceAssetIds.forEach((assetId) => next.delete(assetId));
        return next;
      });
      if (tab === "pending" && !options.allowNonPendingTab) {
        void loadAssets(page, "pending", {
          silent: true,
          excludeAssetIdsOverride: nextLocalProcessingAssetIds,
        });
      } else if (tab === "processing") {
        void loadAssets(page, "processing", { silent: true });
      }
      const targetsNeedingMockup = sourceAssets.filter((asset) => !hasMockupResults(asset, preparationContext.mockupTemplateId));
      let readyAssets = sourceAssets.filter((asset) => hasMockupResults(asset, preparationContext.mockupTemplateId));
      if (targetsNeedingMockup.length > 0) {
        let failed = 0;
        setMockupErrors([]);
        setMockupNotice({
          type: "info",
          message: `自动准备中：正在${targetsNeedingMockup.length} 个货号生${preparationContext.mockupTemplateName}套图。`,
        });
        let done = 0;
        let handledByAssistant = false;
        try {
          markLocalPreparationProgress(preparationTaskId, {
            stage: "mockup",
            total: targetsNeedingMockup.length,
            done: 0,
            failed: 0,
            percent: 0,
            message: `本地助手后台套图启动中：${preparationContext.mockupTemplateName}`,
          });
          const existingTask = preparationTaskId ? localPreparationTasks.find((task) => task.id === preparationTaskId) : undefined;
          const result = await renderMockupsInLocalAssistant(
            targetsNeedingMockup,
            preparationContext.mockupTemplateId,
            mockupBatchConcurrency,
            {
              jobId: existingTask?.localMockupJobId,
              onJobStarted: (job) => {
                if (preparationTaskId) {
                  markLocalPreparationTask(preparationTaskId, { localMockupJobId: job.id });
                }
              },
              onProgress: (job) => {
                const jobFailed = job.failedCount ?? 0;
                const jobDone = Math.max(0, Math.min(targetsNeedingMockup.length, Math.round((job.progress / 100) * targetsNeedingMockup.length)));
                markLocalPreparationProgress(preparationTaskId, {
                  stage: "mockup",
                  total: targetsNeedingMockup.length,
                  done: job.status === "succeeded" ? targetsNeedingMockup.length - jobFailed : jobDone,
                  failed: jobFailed,
                  percent: job.progress,
                  message: job.status === "running" || job.status === "queued"
                    ? "本地助手正在后台套图，页面可以切换到其他店铺继续配置"
                    : statusText(job.status),
                });
              },
            },
          );
          handledByAssistant = true;
        for (const item of Array.isArray(result.items) ? result.items : []) {
            const asset = targetsNeedingMockup.find((target) => target.id === item.sourceAssetId);
          if (item.ok && asset && Array.isArray(item.assets)) {
              applyMockupResult(asset, item.assets);
              readyAssets.push({
                ...asset,
                mockupResults: mergeMockupResults(asset.mockupResults, item.assets),
              });
            } else {
              failed += 1;
              setMockupErrors((current) => [...current, {
                filename: item.sourceSku,
                message: item.error || "本地助手后台套图失败",
              }]);
            }
            done += 1;
            setListingProgress({ stage: "自动套图", total: targetsNeedingMockup.length, done, failed, currentSku: item.sourceSku });
            markLocalPreparationProgress(preparationTaskId, {
              stage: "mockup",
              total: targetsNeedingMockup.length,
              done,
              failed,
              percent: progressPercent(done, targetsNeedingMockup.length),
              currentSku: item.sourceSku,
              message: `本地助手套图完成 ${done}/${targetsNeedingMockup.length}`,
            });
          }
        } catch (assistantError) {
          onMessage(`本地助手批量套图暂不可用，已切换客户端逐项套图${formatLocalMockupError(assistantError)}`);
        }
        if (!handledByAssistant) {
          await runWithConcurrency(targetsNeedingMockup, mockupBatchConcurrency, async (asset) => {
            setListingProgress({ stage: "自动套图", total: targetsNeedingMockup.length, done, failed, currentSku: asset.sku });
            try {
              const result = await renderMockup(asset.id, preparationContext.mockupTemplateId);
              applyMockupResult(asset, result.assets);
              readyAssets.push({
                ...asset,
                mockupResults: mergeMockupResults(asset.mockupResults, result.assets),
              });
            } catch (error) {
              failed += 1;
              setMockupErrors((current) => [...current, {
                filename: asset.sku,
                message: error instanceof Error ? error.message : String(error),
              }]);
            }
            done += 1;
            setListingProgress({ stage: "自动套图", total: targetsNeedingMockup.length, done, failed, currentSku: asset.sku });
            markLocalPreparationProgress(preparationTaskId, {
              stage: "mockup",
              total: targetsNeedingMockup.length,
              done,
              failed,
              percent: progressPercent(done, targetsNeedingMockup.length),
              currentSku: asset.sku,
              message: `客户端逐项套图完成 ${done}/${targetsNeedingMockup.length}`,
            });
          });
        }
        setMockupNotice({
          type: failed > 0 ? "error" : "success",
          message: `自动套图完成：成${targetsNeedingMockup.length - failed} 个，失败 ${failed} 个。`,
        });
      }

      readyAssets = dedupeAssetsById(readyAssets).filter((asset) => hasMockupResults(asset, preparationContext.mockupTemplateId));
      if (readyAssets.length === 0) {
        removeLocalProcessingAssets(sourceAssetIds);
        onMessage("?????????????????????????????");
        if (preparationTaskId) {
          markLocalPreparationTask(preparationTaskId, { status: "failed", error: "???????????" });
          markLocalPreparationProgress(preparationTaskId, {
            stage: "failed",
            total: sourceAssets.length,
            done: 0,
            failed: sourceAssets.length,
            percent: 100,
            message: "???????????",
          });
        }
        return null;
      }
      markLocalPreparationProgress(preparationTaskId, {
        stage: "title",
        total: readyAssets.length,
        done: readyAssets.filter((asset) => Boolean(assetDisplayTitle(asset, preparationContext.draftsByAssetId[asset.id]))).length,
        failed: 0,
        percent: 0,
        message: "正在生成标题并准备上架包",
      });
      const chunks = chunkItems(readyAssets, listingPreparationChunkSize);
      let lastPreparedBatch: CloudListingBatch | null = null;
      let preparedAssets = 0;
      let failedAssets = 0;
      let duplicateAssets = 0;
      const preparationErrors: string[] = [];

      const prepareChunkWithIsolation = async (chunk: CloudAsset[]): Promise<CloudListingBatch[]> => {
        try {
          const batch = await prepareListingBatchFromTargets(chunk, {
            ...options,
            context: preparationContext,
            blocking: false,
            allowNonPendingTab: options.allowNonPendingTab,
            throwOnError: true,
          });
          if (!batch) {
            failedAssets += chunk.length;
            preparationErrors.push(`${chunk.length} 个商品未生成上架包，请检查店铺模板、本地助手店铺同步、标题和套图是否完整。`);
            return [];
          }
          const deferredAssets = Math.max(0, chunk.length - batch.imageSets.length);
          if (deferredAssets > 0) {
            failedAssets += deferredAssets;
            preparationErrors.push(`${deferredAssets} 个商品标题生成失败，已保留到上传中等待重试。`);
          }
          return batch ? [batch] : [];
        } catch (error) {
          if (error instanceof CloudApiError && error.code === "ASSET_ALREADY_SELECTED") {
            if (chunk.length > 1) {
              const middle = Math.ceil(chunk.length / 2);
              return [
                ...await prepareChunkWithIsolation(chunk.slice(0, middle)),
                ...await prepareChunkWithIsolation(chunk.slice(middle)),
              ];
            }
            duplicateAssets += 1;
            removeLocalProcessingAssets([chunk[0].id]);
            return [];
          }
          const message = error instanceof Error ? error.message : String(error);
          preparationErrors.push(message);
          onMessage(message);
          failedAssets += chunk.length;
          return [];
        }
      };

      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        markLocalPreparationProgress(preparationTaskId, {
          stage: "batch",
          total: readyAssets.length,
          done: preparedAssets + duplicateAssets,
          failed: failedAssets,
          percent: progressPercent(preparedAssets + duplicateAssets + failedAssets, readyAssets.length),
          message: `正在生成${index + 1}/${chunks.length} 个上架包（每批最${listingPreparationChunkSize} 个商品）`,
        });
        const batches = await prepareChunkWithIsolation(chunk);
        for (const batch of batches) {
          lastPreparedBatch = batch;
          preparedAssets += batch.imageSets.length;
          if (options.submitAfterPrepare) {
            enqueueAutoSubmitBatch(batch.id);
            const job = await startAutoListingBatch(batch, {
              loading: false,
              navigate: false,
              navigateTo: "imageProcessing",
              silentFailure: true,
            });
            if (job) {
              dequeueAutoSubmitBatch(batch.id);
            }
          }
        }
      }
      if (preparationTaskId) {
        if (failedAssets > 0) {
          const errorSummary = summarizePreparationErrors(preparationErrors);
          markLocalPreparationTask(preparationTaskId, {
            status: "failed",
            error: `?? ${failedAssets} ??????????${errorSummary ? `???${errorSummary}` : "???????????????????????????"} ????????????`,
          });
          markLocalPreparationProgress(preparationTaskId, {
            stage: "failed",
            total: readyAssets.length,
            done: preparedAssets,
            failed: failedAssets,
            percent: progressPercent(preparedAssets + duplicateAssets + failedAssets, readyAssets.length),
            message: `已提${preparedAssets} 个商品，${failedAssets} 个未生成上架包，点击“继续上传”可重试`,
          });
        } else {
          markLocalPreparationTask(preparationTaskId, { status: "prepared", error: undefined });
          markLocalPreparationProgress(preparationTaskId, {
            stage: "submit",
            total: readyAssets.length,
            done: preparedAssets,
            failed: 0,
            percent: 100,
            message: "上架包已生成，正在提交本地助手",
          });
        }
      }
      return lastPreparedBatch;
    } finally {
      setActiveAutoListingRuns((current) => Math.max(0, current - 1));
    }
  };

  const startAutoListing = async () => {
    if (!lastListingBatch) {
      onMessage("当前没有可直接启动的上架包，请使用批量恢复上传。 ");
      return;
    }
    await startAutoListingBatch(lastListingBatch);
  };

  const enqueueAutoSubmitBatch = (batchId: string) => {
    if (!isUuid(batchId)) {
      return;
    }
    if (!autoSubmitAttemptCountRef.current.has(batchId)) {
      autoSubmitAttemptCountRef.current.set(batchId, 0);
    }
    setPendingAutoSubmitBatchIds((current) => new Set([...current, batchId]));
  };

  const dequeueAutoSubmitBatch = (batchId: string) => {
    autoSubmitAttemptCountRef.current.delete(batchId);
    setPendingAutoSubmitBatchIds((current) => {
      if (!current.has(batchId)) {
        return current;
      }
      const next = new Set(current);
      next.delete(batchId);
      return next;
    });
  };


  const autoSubmitPreparedBatch = async (batchId: string) => {
    const attempts = autoSubmitAttemptCountRef.current.get(batchId) ?? 0;
    if (attempts >= 5) {
      dequeueAutoSubmitBatch(batchId);
      onMessage("该上架包连续启动失败，已停止自动重试，请查看任务错误详情。 ");
      return;
    }
    autoSubmitAttemptCountRef.current.set(batchId, attempts + 1);
    setAutoSubmittingBatchIds((current) => new Set([...current, batchId]));
    try {
      const result = await client.getListingBatch(batchId);
      const job = await startAutoListingBatch(result.batch, {
        loading: false,
        navigate: false,
        navigateTo: "imageProcessing",
        silentFailure: attempts < 4,
        refreshBatch: false,
      });
      if (job) {
        dequeueAutoSubmitBatch(batchId);
      }
    } finally {
      setAutoSubmittingBatchIds((current) => {
        if (!current.has(batchId)) {
          return current;
        }
        const next = new Set(current);
        next.delete(batchId);
        return next;
      });
    }
  };

  const startAutoListingBatch = async (
    batch: CloudListingBatch,
    options: StartAutoListingOptions = {},
  ): Promise<JobSummary | null> => {
    if (options.loading !== false) {
      setLoading(true);
    }
    try {
      const latestBatch = options.refreshBatch === false
        ? batch
        : await client.getListingBatch(batch.id)
          .then((result) => result.batch)
          .catch(() => batch);
      const request = buildAutoListingRequest(latestBatch);
      if (!request) {
        if (options.navigate === false && !options.silentFailure) {
          onMessage("上架批次缺少店铺或商品模板配置，请先在待上传图片页保存 Ozon 店铺配置。");
        }
        if (options.navigate !== false && batch.status !== "uploaded") {
          onNavigate?.(options.navigateTo ?? "imageProcessing");
        }
        return null;
      }
      const activeJob = await findActiveAutoListingJob(batch.id);
      if (activeJob) {
        onMessage(`该批次已经在执行中：${activeJob.title}。请到上传中或任务记录查看进度。`);
        if (options.navigate !== false) {
          onNavigate?.(options.navigateTo ?? "imageProcessing");
        }
        return activeJob;
      }
      const job = await api.startAutoListing(request);
      onJobStarted?.(job);
      setLastListingBatch(latestBatch);
      onMessage(`自动上架任务已启动：${job.title}。商品提Ozon 成功后会自动进入已上传图片；库存、条码和活动请在店铺管理的上架后自动运维中单独处理。`);
      if (options.navigate !== false) {
        onNavigate?.(options.navigateTo ?? "jobs");
      }
      return job;
    } catch (error) {
      if (!options.silentFailure) {
        onMessage(error instanceof Error ? error.message : String(error));
      }
      if (options.navigate !== false && batch.status !== "uploaded") {
        onNavigate?.(options.navigateTo ?? "imageProcessing");
      }
      return null;
    } finally {
      if (options.loading !== false) {
        setLoading(false);
      }
    }
  };

  const findActiveAutoListingJob = async (batchId: string) => {
    const jobs = await api.listJobs().catch(() => []);
    return jobs.find((job) => (
      job.kind === "auto_listing"
      && (job.status === "queued" || job.status === "running")
      && job.inputPath === batchId
    )) ?? null;
  };

  const stopAndDeleteProcessingUploads = async () => {
    const sourceAssetIds = [...new Set(processingOverviewAssets.map((asset) => asset.id).filter(Boolean))];
    const batchIds = [...new Set(processingListingBatchIds.filter((batchId) => isUuid(batchId)))];
    if (sourceAssetIds.length === 0 && batchIds.length === 0 && activePreparationTasks.length === 0) { onMessage("当前没有可以停止并删除的上传任务"); return; }
    if (!deleteUploadsConfirm) { setDeleteUploadsConfirm(true); onMessage("????????????????????????????"); return; }
    setDeletingUploads(true);
    try {
      const jobs = await api.listJobs().catch(() => []);
      const localJobIds = new Set(activePreparationTasks.map((task) => task.localMockupJobId).filter((id): id is string => Boolean(id)));
      await Promise.all(jobs.filter((job) => (job.status === "queued" || job.status === "running") && (localJobIds.has(job.id) || (job.kind === "auto_listing" && Boolean(job.inputPath) && batchIds.includes(job.inputPath!)))).map((job) => api.cancelJob(job.id).catch(() => false)));
      const result = await client.deleteListingUploads({ batchIds, sourceAssetIds });
      removeLocalProcessingAssets(sourceAssetIds);
      updateLocalPreparationTasks((current) => current.filter((task) => !task.assetIds.some((assetId) => sourceAssetIds.includes(assetId))));
      batchIds.forEach((batchId) => autoResumeAttemptedBatchIdsRef.current.add(batchId));
      activePreparationTasks.forEach((task) => autoResumeAttemptedPreparationTaskIdsRef.current.add(task.id));
      setDeleteUploadsConfirm(false); setSelectedAssetIds(new Set());
      onMessage(`已停止并删除上传${result.deletedBatches} 个上架批次，${result.deletedMockupAssets} 张套图；${result.releasedSourceAssets} 张原图已返回待上传`);
      await loadAssets(1, "processing", { silent: true });
    } catch (error) { onMessage(error instanceof Error ? error.message : String(error)); } finally { setDeletingUploads(false); }
  };

  const resumeAllProcessingUploads = async () => {
    const message = "正在恢复当前 400 个商品关联的本地任务和上架批次...";
    setProcessingResumeNotice(message);
    onMessage(message);
    return resumeProcessingListingBatches(allProcessingListingBatchIds, "manual");
  };

  const resumeProcessingListingBatches = async (batchIds = allProcessingListingBatchIds, source: "auto" | "manual" = "manual") => {
    const failedBatchIds: string[] = [];
    let resumedPreparationCount = 0;
    if (source === "manual") {
      resumedPreparationCount = await resumeLocalPreparationTasks("manual");
    }
    const targetBatchIds = [...new Set(batchIds)].filter((batchId) => isUuid(batchId));
    if (targetBatchIds.length === 0) {
      if (source === "manual" && resumedPreparationCount === 0) {
        const message = "\u5f53\u524d\u6ca1\u6709\u53ef\u6062\u590d\u7684\u4e0a\u4f20\u4efb\u52a1\u3002";
        setProcessingResumeNotice(message);
        onMessage(message);
      }
      return failedBatchIds;
    }
    if (source === "manual") {
      setLoading(true);
      setProcessingResumeNotice(`\u6b63\u5728\u6062\u590d ${targetBatchIds.length} \u4e2a\u4e0a\u67b6\u6279\u6b21\uff0c\u672c\u5730\u52a9\u624b\u4f1a\u5728\u540e\u53f0\u5904\u7406\u3002`);
    }
    setResumingListingBatchIds((current) => new Set([...current, ...targetBatchIds]));
    try {
      const jobs = await api.listJobs().catch(() => []);
      const activeBatchIds = new Set(
        jobs
          .filter((job) => job.kind === "auto_listing" && (job.status === "queued" || job.status === "running") && job.inputPath)
          .map((job) => job.inputPath!)
      );
      const resumableBatchIds = targetBatchIds.filter((batchId) => !activeBatchIds.has(batchId));
      if (resumableBatchIds.length === 0) {
        if (source === "manual") {
          const message = "\u8fd9\u4e9b\u4e0a\u67b6\u6279\u6b21\u5df2\u7ecf\u5728\u672c\u5730\u52a9\u624b\u4efb\u52a1\u4e2d\uff0c\u8bf7\u5230\u4efb\u52a1\u8bb0\u5f55\u67e5\u770b\u8fdb\u5ea6\u3002";
          setProcessingResumeNotice(message);
          onMessage(message);
          onNavigate?.("jobs");
        }
        return failedBatchIds;
      }

      let started = 0;
      let skipped = targetBatchIds.length - resumableBatchIds.length;
      let failed = 0;
      const loadedBatches: CloudListingBatch[] = [];
      await runWithConcurrency(resumableBatchIds, resumeListingBatchConcurrency, async (batchId) => {
        try {
          const result = await client.getListingBatch(batchId);
          if (result.batch.status === "uploaded") {
            skipped += 1;
            return;
          }
          loadedBatches.push(result.batch);
        } catch (error) {
          failed += 1;
          failedBatchIds.push(batchId);
          if (source === "manual") {
            onMessage(error instanceof Error ? error.message : String(error));
          }
        }
      });

      const allBatchShopIds = [
        ...new Set(loadedBatches.flatMap((batch) => [
          ...batch.shopTargets.map((shop) => shop.externalShopId),
          ...batch.imageSets.map((imageSet) => imageSet.externalShopId),
        ]).filter(Boolean)),
      ];
      if (allBatchShopIds.length > 0) {
        const shopsSynced = await ensureCloudShopsSynced(allBatchShopIds, source);
        if (!shopsSynced) {
          failed += loadedBatches.length;
          failedBatchIds.push(...loadedBatches.map((batch) => batch.id));
          loadedBatches.length = 0;
        }
      }

      await runWithConcurrency(loadedBatches, resumeListingBatchConcurrency, async (batch) => {
        try {
          const batchShopIds = [
            ...batch.shopTargets.map((shop) => shop.externalShopId),
            ...batch.imageSets.map((imageSet) => imageSet.externalShopId),
          ].filter(Boolean);
          if (batchShopIds.length === 0) {
            failed += 1;
            failedBatchIds.push(batch.id);
            return;
          }
          const request = buildAutoListingRequest(batch);
          if (!request) {
            failed += 1;
            failedBatchIds.push(batch.id);
            return;
          }
          const job = await api.startAutoListing(request);
          started += 1;
          onJobStarted?.(job);
          setLastListingBatch(batch);
        } catch (error) {
          failed += 1;
          failedBatchIds.push(batch.id);
          if (source === "manual") {
            onMessage(error instanceof Error ? error.message : String(error));
          }
        }
      });

      if (started > 0) {
        const message = `\u5df2\u542f\u52a8 ${started} \u4e2a\u672c\u5730\u52a9\u624b\u4e0a\u67b6\u4efb\u52a1${skipped > 0 ? `\uff0c\u8df3\u8fc7 ${skipped} \u4e2a\u5df2\u5728\u5904\u7406\u4e2d` : ""}${failed > 0 ? `\uff0c${failed} \u4e2a\u542f\u52a8\u5931\u8d25` : ""}\u3002`;
        setProcessingResumeNotice(`${message} \u53ef\u5728\u4efb\u52a1\u8bb0\u5f55\u67e5\u770b\u5b9e\u65f6\u8fdb\u5ea6\u3002`);
        onMessage(message);
        if (source === "manual") {
          onNavigate?.("jobs");
        }
      } else if (source === "manual") {
        const message = failed > 0 ? "\u4e0a\u67b6\u4efb\u52a1\u542f\u52a8\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u672c\u5730\u52a9\u624b\u548c Ozon \u5e97\u94fa\u914d\u7f6e\u3002" : "\u5f53\u524d\u6ca1\u6709\u9700\u8981\u6062\u590d\u7684\u4e0a\u67b6\u6279\u6b21\u3002";
        setProcessingResumeNotice(message);
        onMessage(message);
      }
      await loadAssets(page, "processing", { silent: true });
      return failedBatchIds;
    } finally {
      setResumingListingBatchIds((current) => {
        const next = new Set(current);
        targetBatchIds.forEach((batchId) => next.delete(batchId));
        return next;
      });
      if (source === "manual") {
        setLoading(false);
      }
    }
  };

  const resumeLocalPreparationTasks = async (source: "auto" | "manual" = "manual") => {
    if (runningPreparationTaskIdsRef.current.size > 0) {
      return 0;
    }
    const currentAssetIds = new Set(localProcessingAssets
      .filter((asset) => !asset.listingStatus?.batchId)
      .map((asset) => asset.id));
    const assetById = new Map(localProcessingAssets.map((asset) => [asset.id, asset]));
    const validRuleById = new Map(productImageRules.map((rule) => [rule.id, rule]));
    const discardedTaskIds = localPreparationTasks
      .filter((task) => task.status !== "prepared" && !task.assetIds.some((assetId) => currentAssetIds.has(assetId)))
      .map((task) => task.id);
    if (discardedTaskIds.length > 0) {
      const discardedIdSet = new Set(discardedTaskIds);
      updateLocalPreparationTasks((current) => current.filter((task) => !discardedIdSet.has(task.id)));
    }
    const tasks: PreparationTaskRun[] = recoveryPreparationTasks
      .filter((task) => task.status !== "running" || !runningPreparationTaskIdsRef.current.has(task.id))
      .filter((task) => !autoResumeAttemptedPreparationTaskIdsRef.current.has(task.id) || source === "manual")
      .map((task) => {
        const assets = task.assetIds
          .filter((assetId) => currentAssetIds.has(assetId))
          .map((assetId) => assetById.get(assetId))
          .filter((asset): asset is CloudAsset => Boolean(asset));
        const rule = assets.length > 0
          ? resolveProductImageRuleForAsset(assets[0], validRuleById, productImageRules)
          : null;
        if (!rule || task.context.shopListingConfigs.length === 0) {
          return null;
        }
        const draftsByAssetId = Object.fromEntries(assets.map((asset, index) => {
          const fallbackShopId = task.context.shopListingConfigs[index % task.context.shopListingConfigs.length].externalShopId;
          return [asset.id, task.context.draftsByAssetId[asset.id] ?? createListingDraftFromAsset(asset, fallbackShopId)];
        }));
        return {
          id: task.id,
          assets,
          context: {
            ...task.context,
            runId: task.id,
            ratioFamily: ratioFamilyForAspectRatio(rule.aspectRatio) as CloudAsset["ratioFamily"],
            productImageRuleId: rule.id,
            productType: rule.productType,
            aspectRatio: rule.aspectRatio,
            draftsByAssetId,
          },
        };
      })
      .filter((task): task is PreparationTaskRun => Boolean(task && task.assets.length > 0));
    const legacyKey = `${orphanPreparationAssets.map((asset) => asset.id).sort().join("|")}::${autoResumeSetupKey}`;
    if (source === "manual" && orphanPreparationAssets.length > 0 && legacyPreparationResumeKeyRef.current !== legacyKey) {
      const context = createAutoListingPreparationContext(orphanPreparationAssets);
      if (context) {
        legacyPreparationResumeKeyRef.current = legacyKey;
        const taskId = createLocalPreparationTask(orphanPreparationAssets, context);
        tasks.push({
          id: taskId,
          assets: orphanPreparationAssets,
          context,
          isLegacy: true,
        });
      } else if (source === "manual") {
        onMessage("本地恢复任务缺少可用的商品、店铺或模板配置。");
      }
    }

    if (tasks.length === 0) {
      if (source === "manual" && processingListingBatchIds.length === 0) {
        onMessage(`当前 ${currentAssetIds.size} 个商品没有可恢复的本地上架任务或已关联批次。`);
      }
      return 0;
    }
    tasks.forEach((task) => autoResumeAttemptedPreparationTaskIdsRef.current.add(task.id));
    setResumingPreparationTaskIds((current) => new Set([...current, ...tasks.map((task) => task.id)]));
    await runWithConcurrency(tasks, preparationResumeConcurrency, async (task) => {
      if (runningPreparationTaskIdsRef.current.has(task.id)) {
        return;
      }
      runningPreparationTaskIdsRef.current.add(task.id);
      try {
        await runAutoListingPreparationForAssets(task.assets, {
          submitAfterPrepare: true,
          blocking: false,
          allowNonPendingTab: true,
          context: task.context,
          preparationTaskId: task.id,
        });
      } finally {
        runningPreparationTaskIdsRef.current.delete(task.id);
        setResumingPreparationTaskIds((current) => {
          const next = new Set(current);
          next.delete(task.id);
          return next;
        });
      }
    });
    return tasks.length;
  };

  const buildAutoListingRequest = (batch: CloudListingBatch): AutoListingRequest | null => {
    const snapshotByExternalShopId = new Map<string, CloudListingConfigSnapshot>();
    for (const shop of batch.shopTargets) {
      if (shop.configSnapshot) {
        snapshotByExternalShopId.set(shop.externalShopId, shop.configSnapshot);
      }
    }
    for (const imageSet of batch.imageSets) {
      if (imageSet.configSnapshot && !snapshotByExternalShopId.has(imageSet.externalShopId)) {
        snapshotByExternalShopId.set(imageSet.externalShopId, imageSet.configSnapshot);
      }
    }

    const externalShopIds = [...new Set(batch.imageSets.map((imageSet) => imageSet.externalShopId))];
    const recoveredShopNames: string[] = [];
    for (const externalShopId of externalShopIds) {
      const existingSnapshot = snapshotByExternalShopId.get(externalShopId);
      if (existingSnapshot?.templateProduct !== undefined && existingSnapshot.templateProduct !== null) {
        continue;
      }
      const fallbackSnapshot = buildFallbackListingSnapshot(externalShopId, batch, existingSnapshot);
      if (!fallbackSnapshot) {
        return null;
      }
      snapshotByExternalShopId.set(externalShopId, fallbackSnapshot);
      recoveredShopNames.push(fallbackSnapshot.shopName ?? externalShopId);
    }
    if (recoveredShopNames.length > 0) {
      onMessage(`这个上架包是旧版本生成的，缺少店铺执行配置，已使用当前保存的店铺配置继续上传${recoveredShopNames.join("")}。`);
    }

    const shopRuntimeConfigs = externalShopIds.map((externalShopId) => {
      const snapshot = snapshotByExternalShopId.get(externalShopId)!;
      const localShop = localShopByExternalId.get(externalShopId) || localShops.find((shop) => shop.id === snapshot.localShopId);
      return { externalShopId, snapshot, localShop };
    });
    const missingShop = shopRuntimeConfigs.find((item) => !item.localShop);
    if (missingShop) {
      onMessage(`请先在本地助手里同步店铺${missingShop.snapshot.shopName ?? missingShop.externalShopId}`);
      return null;
    }
    const missingTemplate = shopRuntimeConfigs.find((item) => item.snapshot.templateProduct === undefined || item.snapshot.templateProduct === null);
    if (missingTemplate) {
      onMessage(`上架包里的商品模板快照不完整${missingTemplate.snapshot.shopName ?? missingTemplate.externalShopId}。请回到待上传图片页重新选择模板并生成任务。`);
      return null;
    }

    const localShopIdByExternalShopId = new Map(shopRuntimeConfigs.map((item) => [item.externalShopId, item.localShop!.id]));
    return {
      batchId: batch.id,
      cloudApiBaseUrl,
      cloudAuthToken: getCloudToken() || undefined,
      cloudExternalShopIdByShopId: Object.fromEntries(shopRuntimeConfigs.map((item) => [item.localShop!.id, item.externalShopId])),
      mockupTemplateId: batch.mockupTemplateId,
      mockupTemplateName: batch.mockupTemplateName,
      items: batch.imageSets.filter((imageSet) => !imageSet.completedAt).map((imageSet) => ({
        sourceAssetId: imageSet.sourceAssetId,
        sourceSku: imageSet.sourceSku,
        shopId: localShopIdByExternalShopId.get(imageSet.externalShopId) || imageSet.externalShopId,
        title: imageSet.title?.trim() || "",
        imageUrls: imageSet.imageUrls,
      })),
      shopConfigs: shopRuntimeConfigs.map(({ snapshot, localShop }) => ({
        shopId: localShop!.id,
        templateProduct: snapshot.templateProduct,
        templateVideoLinks: snapshot.templateVideoLinks ?? [],
        uploadTemplateVideo: snapshot.uploadTemplateVideo ?? false,
        autoGenerateBarcode: false,
        autoUpdateStock: false,
        autoAddToAction: false,
        autoWarehouseId: undefined,
        autoStock: undefined,
        autoActionId: undefined,
        autoActionPrice: undefined,
        autoActionStock: undefined,
        postListingDelayMinutes: 0,
        actionDelayMinutes: 0,
        actionRetryCount: 1,
        actionRetryIntervalMinutes: 10,
      })),
    };
  };

  const buildFallbackListingSnapshot = (
    externalShopId: string,
    batch: CloudListingBatch,
    existingSnapshot?: CloudListingConfigSnapshot,
  ): CloudListingConfigSnapshot | null => {
    const shopName = existingSnapshot?.shopName
      ?? batch.shopTargets.find((shop) => shop.externalShopId === externalShopId)?.shopName
      ?? batch.imageSets.find((imageSet) => imageSet.externalShopId === externalShopId)?.shopName
      ?? selectedShopNameById.get(externalShopId)
      ?? externalShopId;
    const config = activeShopListingConfigs.find((item) => item.externalShopId === externalShopId);
    if (!config) {
      onMessage(`旧上架包缺少店铺执行配置${shopName}。请先在待上传图片页保存该店铺的商品模板，再回到上传中点击继续上传。`);
      return null;
    }
    const localShop = localShopByExternalId.get(externalShopId) || localShops.find((shop) => shop.id === existingSnapshot?.localShopId);
    if (!localShop) {
      onMessage(`请先在本地助手里同步店铺${shopName}`);
      return null;
    }
    const localTemplate = localProductTemplates.find((template) => template.id === config.localTemplateId);
    if (!localTemplate) {
      onMessage(`请先${shopName} 选择本地 Ozon 商品模板。`);
      return null;
    }
    return buildListingConfigSnapshot(config, {
      shopName,
      localShop,
      localTemplate,
    });
  };

  const markLastListingBatchUploaded = async () => {
    if (!lastListingBatch) {
      onMessage("????????????");
      return;
    }
    setLoading(true);
    try {
      const result = await client.markListingBatchUploaded(lastListingBatch.id);
      setLastListingBatch(result.batch);
      await loadAssets(page);
      onMessage("??????????????????????????????????");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const updateSelectedUploadedProductImages = async () => {
    if (selectedUploadedAssets.length === 0) {
      onMessage("请先勾选要更新图片的已上传商品。");
      return;
    }
    if (localShops.length === 0) {
      onMessage("请先在本地助手同步店铺并保存 Ozon API Key。");
      return;
    }
    const localShopIds = new Set(localShops.map((shop) => shop.id));
    const targets: UploadedRepairTarget[] = [];
    for (const asset of selectedUploadedAssets) {
      const status = asset.listingStatus;
      const shops = status?.shops ?? [];
      for (const shop of shops) {
        if (!shop.externalShopId || !localShopIds.has(shop.externalShopId)) {
          continue;
        }
        targets.push({
          asset,
          externalShopId: shop.externalShopId,
          shopName: shop.shopName,
          batchId: status?.batchId || undefined,
        });
      }
    }
    if (targets.length === 0) {
      onMessage("勾选商品没有匹配到本地店铺配置，无法提交 Ozon 图片更新。");
      return;
    }

    const targetAssets = dedupeAssetsById(targets.map((target) => target.asset));
    setLoading(true);
    setMockupErrors([]);
    setRepairImageJobId("");
    setRepairImageProgress({
      phase: "running",
      message: `正在重新生成 ${targetAssets.length} 个货号的${currentMockupTemplateName}套图...`,
      scanned: 0,
      total: targetAssets.length,
      skipped: selectedUploadedAssets.length - targetAssets.length,
    });

    const generatedByAssetId = new Map<string, CloudMockupAsset[]>();
    const errors: UploadError[] = [];
    let generatedScenes = 0;
    try {
      let handledByAssistant = false;
      try {
        const result = await renderMockupsInLocalAssistant(targetAssets, selectedMockupTemplate);
        handledByAssistant = true;
        for (const item of Array.isArray(result.items) ? result.items : []) {
          const asset = targetAssets.find((target) => target.id === item.sourceAssetId);
          if (item.ok && asset && Array.isArray(item.assets) && item.assets.length > 0) {
            generatedByAssetId.set(asset.id, item.assets);
            generatedScenes += item.assets.length;
            applyMockupResult(asset, item.assets);
          } else {
            errors.push({
              filename: item.sourceSku,
              message: item.error || "套图生成失败",
            });
          }
          setMockupErrors([...errors]);
          setRepairImageProgress((current) => ({
            phase: "running",
            message: `正在重新生成 ${targetAssets.length} 个货号的${currentMockupTemplateName}套图...`,
            scanned: generatedByAssetId.size + errors.length,
            total: targetAssets.length,
            skipped: current?.skipped,
          }));
        }
      } catch (assistantError) {
        onMessage(`本地助手批量套图暂不可用，已切换兜底生成：${formatLocalMockupError(assistantError)}`);
      }
      if (!handledByAssistant) {
        await runWithConcurrency(targetAssets, mockupBatchConcurrency, async (asset) => {
          setRenderingAssetId(asset.id);
          setRepairImageProgress((current) => ({
            phase: "running",
            message: `正在重新生成 ${asset.sku} 的${currentMockupTemplateName}套图...`,
            scanned: generatedByAssetId.size + errors.length,
            total: targetAssets.length,
            skipped: current?.skipped,
          }));
          try {
            const result = await renderMockup(asset.id, selectedMockupTemplate);
            generatedByAssetId.set(asset.id, result.assets);
            generatedScenes += result.generated;
            applyMockupResult(asset, result.assets);
          } catch (error) {
            errors.push({
              filename: asset.sku,
              message: error instanceof Error ? error.message : String(error),
            });
            setMockupErrors([...errors]);
          }
        });
      }

      const syncItems = targets
        .map((target) => {
          const generatedAssets = generatedByAssetId.get(target.asset.id) ?? [];
          if (generatedAssets.length === 0) {
            return null;
          }
          return {
            batchId: target.batchId && isUuid(target.batchId) ? target.batchId : undefined,
            externalShopId: target.externalShopId,
            sourceAssetId: target.asset.id,
            sourceSku: target.asset.sku,
            imageAssetIds: generatedAssets.map((asset) => asset.id),
          };
        })
        .filter((item): item is NonNullable<typeof item> => item !== null);

      if (syncItems.length === 0) {
        const message = "所选商品的新套图全部生成失败，未提交 Ozon 更新。";
        setRepairImageProgress({
          phase: "failed",
          message,
          scanned: targetAssets.length,
          total: targetAssets.length,
          skipped: targets.length,
        });
        onMessage(message);
        return;
      }

      setRepairImageProgress({
        phase: "running",
        message: "正在同步新套图记录并提交 Ozon 图片更新...",
        scanned: targetAssets.length,
        total: syncItems.length,
        skipped: errors.length,
      });
      const syncResult = await client.updateListingRepairImages({ items: syncItems });
      const syncErrors = syncResult.errors.map((error) => ({
        filename: `${error.sourceSku} / ${selectedShopNameById.get(error.externalShopId) ?? error.externalShopId}`,
        message: error.message,
      }));
      if (syncErrors.length > 0) {
        errors.push(...syncErrors);
        setMockupErrors([...errors]);
      }
      if (syncResult.items.length === 0) {
        const message = "新套图已生成，但没有成功同步到已上传记录，未提交 Ozon 更新。";
        setRepairImageProgress({
          phase: "failed",
          message,
          scanned: targetAssets.length,
          total: syncItems.length,
          skipped: syncErrors.length,
        });
        onMessage(message);
        return;
      }

      const job = await api.startListingImageRepair({
        cloudApiBaseUrl,
        cloudAuthToken: getCloudToken() || undefined,
        items: syncResult.items,
      });
      setRepairImageJobId(job.id);
      setRepairImageProgress({
        phase: "running",
        message: repairJobMessage(job),
        scanned: targetAssets.length,
        total: syncResult.items.length,
        skipped: errors.length,
        job,
      });
      onJobStarted?.(job);
      const message = `已重新生成 ${generatedByAssetId.size} 个货号、${generatedScenes} 张套图，并提交 ${syncResult.items.length} 个 Ozon 商品图片更新${errors.length > 0 ? `，跳过/失败 ${errors.length} 项` : ""}。`;
      onMessage(message);
      await loadAssets(page, "uploaded", { silent: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setRepairImageProgress({
        phase: "failed",
        message,
        scanned: generatedByAssetId.size,
        total: targetAssets.length,
        skipped: errors.length,
      });
      onMessage(message);
    } finally {
      setRenderingAssetId("");
      setBatchMockupProgress(null);
      setLoading(false);
    }
  };

  const repairUploadedImageLinks = async () => {
    if (localShops.length === 0) {
      onMessage("????????????????????????????");
      return;
    }
    setLoading(true);
    setRepairImageProgress({
      phase: "scanning",
      message: "???????????????...",
      scanned: 0,
      total: 0,
      skipped: 0,
    });
    try {
      const localShopIds = new Set(localShops.map((shop) => shop.id));
      const allItems: ListingImageRepairItem[] = [];
      let offset = 0;
      const limit = 200;
      while (allItems.length < 2000) {
        const result = await client.listListingImageRepairs({
          keyword: keyword.trim() || undefined,
          externalShopId: processingShopId || undefined,
          limit,
          offset,
        });
        allItems.push(...result.items);
        setRepairImageProgress({
          phase: "scanning",
          message: "???????????????...",
          scanned: allItems.length,
          total: result.total,
          skipped: 0,
        });
        offset += result.items.length;
        if (result.items.length === 0 || offset >= result.total) {
          break;
        }
      }
      if (allItems.length === 0) {
        setRepairImageProgress({
          phase: "succeeded",
          message: "???????????????",
          scanned: 0,
          total: 0,
          skipped: 0,
        });
        onMessage("??????????????????????? Ozon???????????????????????");
        return;
      }
      const repairItems = allItems.filter((item) => localShopIds.has(item.externalShopId));
      const missingShopCount = allItems.length - repairItems.length;
      if (repairItems.length === 0) {
        setRepairImageProgress({
          phase: "failed",
          message: `?? ${allItems.length} ??????????????? Ozon API ???`,
          scanned: allItems.length,
          total: allItems.length,
          skipped: missingShopCount,
        });
        onMessage(`?? ${allItems.length} ??????????????? Ozon API ?????????????????`);
        return;
      }
      setRepairImageProgress({
        phase: "running",
        message: "???????????????????...",
        scanned: allItems.length,
        total: allItems.length,
        skipped: missingShopCount,
      });
      const job = await api.startListingImageRepair({
        cloudApiBaseUrl,
        cloudAuthToken: getCloudToken() || undefined,
        items: repairItems,
      });
      setRepairImageJobId(job.id);
      setRepairImageProgress({
        phase: "running",
        message: repairJobMessage(job),
        scanned: allItems.length,
        total: repairItems.length,
        skipped: missingShopCount,
        job,
      });
      onJobStarted?.(job);
      onMessage(`????????????${repairItems.length} ????????????????? Ozon ?????${missingShopCount > 0 ? ` ${missingShopCount} ???????????????` : ""}??????????????????????????`);
    } catch (error) {
      setRepairImageProgress({
        phase: "failed",
        message: error instanceof Error ? error.message : String(error),
      });
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const toggleAssetSelection = (assetId: string, selected: boolean) => {
    const asset = assets.find((item) => item.id === assetId);
    if (selected && asset?.listingStatus && tab !== "uploaded") {
      onMessage(`${asset.sku} 已经被选择或上传，不能重复选择。`);
      return;
    }
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(assetId);
      } else {
        next.delete(assetId);
      }
      return next;
    });
  };

  const selectCurrentPageAssets = () => {
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      for (const asset of selectableAssets) {
        next.add(asset.id);
      }
      return next;
    });
  };

  const selectCurrentPageUnrenderedAssets = () => {
    setSelectedAssetIds((current) => {
      const next = new Set(current);
      for (const asset of pageAssetsWithoutCurrentMockup) {
        next.add(asset.id);
      }
      return next;
    });
    onMessage(`已选择本页 ${pageAssetsWithoutCurrentMockup.length} 张未${currentMockupTemplateName}的原图。`);
  };

  const renderCurrentPageUnrenderedAssets = () => {
    if (pageAssetsWithoutCurrentMockup.length === 0) {
      onMessage(`当前页没有未${currentMockupTemplateName}的图片。`);
      return;
    }
    renderSelectedAssetsMockups(pageAssetsWithoutCurrentMockup);
  };

  const selectCurrentPageAndPrepare = async () => {
    if (selectableAssets.length === 0) {
      onMessage("当前页没有可上架的待上传图片");
      return;
    }
    setSelectedAssetIds(new Set(selectableAssets.map((asset) => asset.id)));
    enqueueAutoListingPreparation(selectableAssets);
  };

  const copySku = async (asset: CloudAsset) => {
    try {
      await window.navigator.clipboard.writeText(asset.sku);
      onMessage(`已复制货号：${asset.sku}`);
    } catch {
      onMessage(`货号${asset.sku}`);
    }
  };

  const ensureCloudShopsSynced = async (externalShopIds: string[], source: "auto" | "manual" = "manual") => {
    const cloudShopIds = new Set(shops.map(readExternalShopId));
    const missingLocalShops = [...new Set(externalShopIds)]
      .filter((externalShopId) => !cloudShopIds.has(externalShopId))
      .map((externalShopId) => localShopByExternalId.get(externalShopId))
      .filter((shop): shop is Shop => Boolean(shop));
    if (missingLocalShops.length === 0) {
      return true;
    }
    let recoveredAfterRetry = false;
    try {
      await runWithConcurrency(missingLocalShops, 3, async (shop) => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= 3; attempt += 1) {
          try {
            await client.syncShop(shop);
            recoveredAfterRetry ||= attempt > 1;
            return;
          } catch (error) {
            lastError = error;
            if (attempt < 3) {
              await delay(attempt * 1_000);
            }
          }
        }
        throw lastError;
      });
      await onCloudShopsChanged?.();
      if (recoveredAfterRetry) {
        onMessage("店铺云端同步已恢复，正在继续创建上架任务。");
      } else if (source === "manual") {
        onMessage(`???????????${missingLocalShops.map((shop) => shop.name).join("?")}????????`);
      }
      return true;
    } catch (error) {
      onMessage(`店铺自动同步到云端失败：${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  };

  const changePageSize = (value: number) => {
    setPageSize(value);
    setPage(1);
    loadAssets(1, tab, { pageSizeOverride: value });
  };

  const changeListingShopFilter = (value: string) => {
    setProcessingShopId(value);
    setPage(1);
    loadAssets(1, tab, { externalShopIdOverride: value });
  };
  const isPending = tab === "pending";
  const isUpload = tab === "upload";
  const isProcessing = tab === "processing";
  const isFeatured = tab === "featured";
  const isUploaded = tab === "uploaded";
  const visibleUploadErrors = uploadErrors.length > 0 ? uploadErrors : uploadTask?.errors ?? [];
  const uploadTaskRunning = loading || isFreshRunningUploadTask(uploadTask);
  const submitListingDisabledReason = loading
    ? "正在处理"
    : !lastListingBatch
      ? "请先点击生成上架包，成功后才能提交到店铺上架"
      : lastListingBatch.status === "uploaded"
        ? "已提交"
        : "提交到店铺上";

  if (isProcessing) {
    return (
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>{galleryModeTitle(tab)}</h2>
            <p className="muted">{galleryModeDescription(tab)}</p>
          </div>
          <div className="toolbar">
            <button className="secondary-button" disabled={loading || uploadResumeBusy} onClick={resumeAllProcessingUploads}>
              <PackageCheck size={15} /> {uploadResumeBusy ? "正在恢复" : "批量恢复上传"}
            </button>
            <button className="primary-button" disabled={listingReconciliationLoading} onClick={() => loadListingReconciliation()}>
              <RefreshCw size={15} /> 刷新任务中心
            </button>
            <button className="danger-button" disabled={deletingUploads} onClick={stopAndDeleteProcessingUploads}>
              <Trash2 size={15} /> {deletingUploads ? "正在删除" : "停止并删除"}
            </button>
          </div>
        </div>
        <AutoListingTaskCenter
          summary={autoListingTaskCenterSummary}
          tasks={autoListingTaskCenterTasks}
          loading={listingReconciliationLoading}
          error={listingReconciliationError}
          onRefresh={() => loadListingReconciliation()}
        />
      </section>
    );
  }

  return (
    <section className="panel">
      <div className="panel-header">
        <div>
          <h2>{galleryModeTitle(tab)}</h2>
          <p className="muted">{galleryModeDescription(tab)}</p>
        </div>
        {!isUpload ? <div className="toolbar">
          <div className="segmented-control" title="切换展示方式">
            <button className={viewMode === "grid" ? "active" : ""} onClick={() => setViewMode("grid")} title="图片展示">
              <Grid2X2 size={15} />
            </button>
            {isPending || isProcessing || isUploaded ? <button className={viewMode === "list" ? "active" : ""} onClick={() => setViewMode("list")} title="列表展示">
              <List size={15} />
            </button> : null}
          </div>
          {isUploaded ? (
            <button className="secondary-button" disabled={loading || selectedUploadedAssets.length === 0} onClick={updateSelectedUploadedProductImages} title="重新生成所选商品的当前样机套图，并更新 Ozon 商品图片">
              <Wand2 size={15} /> 更新已选商品图片
            </button>
          ) : null}
          <button className="primary-button" disabled={loading} onClick={search}>
            <RefreshCw size={15} /> 查询图片
          </button>
        </div> : null}
      </div>

      {isPending ? (
        <div className="listing-command-center">
          <div className="listing-command-main">
            <span className="eyebrow">上传商品</span>
            <strong>选好图片和设置后，一次点击自动套图、生成标题并上架到店铺</strong>
            <div className="listing-command-steps">
              <span>1 选图</span>
              <span>2 套图</span>
              <span>3 标题</span>
              <span>4 上架</span>
              <span>5 店铺运维接管</span>
            </div>
          </div>
          <div className="listing-command-status">
            <span>{listingPreferenceStatus}</span>
            <span>{selectedListingTargetText}</span>
            <span>{activeShopListingConfigs.length > 0 ? `已配${activeShopListingConfigs.length} 个店铺` : "还未配置上架店铺"}</span>
            <span>{selectedProductRuleText ? `商品 ${selectedProductRuleText}` : "请先选择商品类型和图片比例"}</span>
            <span>当前样机 {currentMockupTemplateName}</span>
            {isPreparingAutoListing ? <span>后台正在处理 {activeAutoListingRuns} 批，可继续配置其他店</span> : null}
            {configuredShopSummary ? <span title={configuredShopSummary}>{configuredShopSummary}</span> : null}
          </div>
          <div className="listing-command-actions">
            <button className="secondary-button" disabled={loading} onClick={() => onNavigate?.("imageUpload")}>
              <Upload size={15} /> 图片上传
            </button>
            <button className="secondary-button" disabled={loading || selectableAssets.length === 0} onClick={selectCurrentPageAssets}>
              <List size={15} /> 选择本页
            </button>
            <button
              className="primary-button"
              disabled={Boolean(oneClickListingDisabledReason)}
              onClick={runOneClickListingForSelectedAssets}
              title={oneClickListingDisabledReason || "自动完成套图、标题并提交到店铺上架；库存、条码和活动由店铺自动运维处"}
            >
              <PackageCheck size={15} /> 选中图片一键上架
            </button>
            <button
              className="secondary-button"
              disabled={loading}
              onClick={() => onNavigate?.("imageProcessing")}
              title="查看已经进入自动上架流程的图片和进度"
            >
              <RefreshCw size={15} /> 查看上传
            </button>
          </div>
        </div>
      ) : null}

      {isProcessing ? (
        <div className="processing-overview">
          <div className="processing-overview-card">
            <span>上传中商品</span>
            <strong>{processingTotalText}</strong>
            <em>当前显示 / 当前筛选总数，后台每 5 秒刷新</em>
          </div>
          <div className="processing-overview-card">
            <span>套图进度</span>
            <strong>{processingSummary.mockupDone}/{processingOverviewTotal}</strong>
            <em>{currentMockupTemplateName} · {processingSummary.mockupImages} 张效果图 · 本机并发 {mockupBatchConcurrency}</em>
          </div>
          <div className="processing-overview-card">
            <span>标题进度</span>
            <strong>{processingSummary.titleDone}/{processingOverviewTotal}</strong>
            <em>{processingTitlePending} 个待生成</em>
          </div>
          <div className="processing-overview-card">
            <span>上架</span>
            <strong>{processingSummary.batchCount}</strong>
            <em>{processingSummary.shopCount} 个店铺任务</em>
          </div>
          <div className="processing-overview-card processing-action-card">
            <span>{"\u4e0a\u4f20\u4efb\u52a1"}</span>
            <strong>{isResumingUploadTasks ? "\u5904\u7406\u4e2d" : pendingUploadTaskCount}</strong>
            <em>{processingResumeNotice || (isResumingUploadTasks ? "\u6b63\u5728\u63d0\u4ea4\u7ed9\u672c\u5730\u52a9\u624b" : "\u5f85\u5957\u56fe/\u6807\u9898/\u4e0a\u67b6")}</em>
            <button
              className="primary-button"
              disabled={loading || uploadResumeBusy}
              onClick={resumeAllProcessingUploads}
              title={"\u4ece\u4e91\u7aef\u91cd\u65b0\u67e5\u627e\u5168\u90e8\u5f85\u4e0a\u67b6\u6279\u6b21\uff0c\u5e76\u4ea4\u7ed9\u672c\u5730\u52a9\u624b\u5e76\u53d1\u6062\u590d"}
            >
              {uploadResumeBusy ? <LoaderCircle size={15} className="spin-icon" /> : <PackageCheck size={15} />}
              {uploadResumeBusy ? "\u6b63\u5728\u6062\u590d" : "\u6279\u91cf\u6062\u590d\u4e0a\u4f20"}
            </button>
            <button className="danger-button" disabled={deletingUploads || (pendingUploadTaskCount === 0 && processingOverviewAssets.length === 0)} onClick={stopAndDeleteProcessingUploads}>
              <Trash2 size={15} /> {deletingUploads ? "正在删除" : deleteUploadsConfirm ? "确认删除" : "停止并删除"}
            </button>
          </div>
        </div>
      ) : null}

      {isProcessing ? (
        <ListingReconciliationPanel
          summary={listingReconciliation}
          shops={visibleListingShopProgress}
          loading={listingReconciliationLoading}
          error={listingReconciliationError}
          onRefresh={() => loadListingReconciliation()}
        />
      ) : null}

      <div className="form-grid compact-form-grid gallery-filter-grid">
        <div className="field">
          <label>商品类型和图片比</label>
          <select aria-label="商品类型和图片比" value={selectedProductImageRuleId} onChange={(event) => setSelectedProductRule(event.target.value)}>
            <option value="">全部商品类型</option>
            {productImageRules.map((rule) => <option key={rule.id} value={rule.id}>{productImageRuleLabel(rule)}</option>)}
          </select>
        </div>
        <div className="field">
          <label>货号关键</label>
          <input value={keyword} onChange={(event) => setKeyword(event.target.value)} onKeyDown={(event) => {
            if (event.key === "Enter") search();
          }} />
        </div>
        {(isPending || isUploaded) ? <div className="field">
          <label>过滤已用货号</label>
          <select value={hideUsed ? "yes" : "no"} onChange={(event) => setHideUsed(event.target.value === "yes")} disabled={!isPending}>
            <option value="yes">过滤</option>
            <option value="no">不过</option>
          </select>
        </div> : null}
        {isPending ? <div className="field">
          <label>套图状态</label>
          <select
            aria-label="套图状态"
            value={mockupStatus}
            onChange={(event) => setMockupStatus(event.target.value as MockupStatusFilter)}
            disabled={!isPending && !isUploaded}
          >
            {mockupStatusOptions.map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div> : null}
        <div className="field">
          <label>每页数量</label>
          <select value={pageSize} onChange={(event) => changePageSize(Number(event.target.value))}>
            {pageSizeOptions.map((value) => <option key={value} value={value}>{value} 张</option>)}
          </select>
        </div>
        {isPending ? <div className="field">
          <label>记录使用店铺</label>
          <select value={selectedShopId} onChange={(event) => setSelectedShopId(event.target.value)} disabled={!isPending}>
            <option value="">选择店铺</option>
            {selectedShopOptions.map((shop) => (
              <option key={shop.id} value={shop.id}>{shop.name}</option>
            ))}
          </select>
        </div> : null}
        {(isProcessing || isUploaded) ? <div className="field">
          <label>{isProcessing ? "上传店铺" : "已上传店"}</label>
          <select value={processingShopId} onChange={(event) => changeListingShopFilter(event.target.value)}>
            <option value="">全部店铺</option>
            {selectedShopOptions.map((shop) => (
              <option key={shop.id} value={shop.id}>{shop.name}</option>
            ))}
          </select>
        </div> : null}
        {isPending ? <div className="field">
          <label>当前套图样机</label>
          <select
            aria-label="当前套图样机"
            value={selectedMockupTemplate}
            onChange={(event) => setSelectedMockupTemplate(event.target.value)}
            disabled={!isPending}
          >
            {mockupTemplates.map((option) => (
              <option key={option.id} value={option.id}>{mockupTemplateLabel(option)}</option>
            ))}
          </select>
        </div> : null}
      </div>

      {isPending ? (
        <div className="mockup-template-section">
          <div className="panel-header compact-panel-header">
            <div>
              <h3>选择套图样机</h3>
              <p className="muted">这里展示的是管理员已处理并发布的可用样机，选择后再对图库原图生成套图</p>
            </div>
          </div>
          <div className="mockup-template-grid">
            {mockupTemplates.map((template) => (
              <button
                key={template.id}
                className={`mockup-template-card ${selectedMockupTemplate === template.id ? "active" : ""}`}
                type="button"
                onClick={() => setSelectedMockupTemplate(template.id)}
                aria-pressed={selectedMockupTemplate === template.id}
              >
                <div className="mockup-template-preview">
                  {template.previewUrl ? (
                    <img src={template.previewUrl} alt={`${template.name}预览`} loading="lazy" decoding="async" />
                  ) : (
                    <Images size={32} />
                  )}
                </div>
                <div className="mockup-template-info">
                  <span className="mockup-template-status">{template.status === "custom" ? "自定义" : "内置"}</span>
                  <strong>{template.name}</strong>
                  <em>{template.description || "已发布，可直接生成套图"}</em>
                  <span>{template.productType || "通用商品"} · {template.sceneCount} 张效果图</span>
                  <span>原图：{template.sourceAspectRatio || "按样机要"} · 输出：{template.outputWidth}x{template.outputHeight}</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {isUpload ? <div className="panel-subsection upload-workbench">
        <div className="panel-header">
          <div>
            <h3>批量上传图片</h3>
            <p className="muted">可选择多张图片或整个文件夹，货号默认取文件名；每批最${maxUploadBatchSize} 张且${maxUploadBatchLabel}，会按体积自动拆批上传</p>
          </div>
          <div className="toolbar">
            <button className="secondary-button" disabled={uploadTaskRunning || (!uploadTask && uploadFiles.length === 0)} onClick={clearUploadTask}>
              清空
            </button>
            <button className="primary-button" disabled={uploadTaskRunning || uploadFiles.length === 0 || !selectedProductImageRuleId || uploadExceedsStorage} onClick={uploadBatch}>
              <Upload size={15} /> 上传 {uploadFiles.length || ""}
            </button>
          </div>
        </div>
        <div className="form-grid upload-picker-grid">
          <div className="field">
            <label>商品类型和图片比</label>
            <select
              value={selectedProductImageRuleId}
              onChange={(event) => setSelectedProductRule(event.target.value)}
              disabled={uploadTaskRunning}
            >
              <option value="">请选择后台已维护的类型和比</option>
              {productImageRules.map((rule) => (
                <option key={rule.id} value={rule.id}>{rule.productType} · {rule.aspectRatio}</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>选择图片文件</label>
            <input
              type="file"
              multiple
              accept="image/png,image/jpeg,image/webp"
              disabled={uploadTaskRunning}
              onChange={(event) => {
                chooseUploadFiles(event.target.files, "files");
                event.currentTarget.value = "";
              }}
            />
          </div>
          <div className="field">
            <label>选择整个文件</label>
            <input
              {...({
                type: "file",
                multiple: true,
                accept: "image/png,image/jpeg,image/webp",
                disabled: uploadTaskRunning,
                webkitdirectory: "",
                directory: "",
                onChange: (event) => {
                  chooseUploadFiles(event.target.files, "folder");
                  event.currentTarget.value = "";
                },
              } as DirectoryInputProps)}
            />
          </div>
        </div>
        {cloudUser ? (
          <div className="gallery-summary-row">
            <span>图库容量</span>
            <span>已用 {formatFileSize(galleryStorageUsedBytes)}</span>
            <span>上限 {galleryStorageLimitBytes > 0 ? formatFileSize(galleryStorageLimitBytes) : "不限"}</span>
            <span>剩余 {Number.isFinite(galleryStorageRemainingBytes) ? formatFileSize(galleryStorageRemainingBytes) : "不限"}</span>
            {(uploadExceedsStorage || localUploadExceedsStorage) ? <span className="badge warn">本次选择超过剩余额度</span> : null}
          </div>
        ) : null}
        <div className="upload-task-card local-upload-card">
          <div className="gallery-summary-row">
            <span>客户端后台上</span>
            <span>{localUploadSelection ? `${localUploadSelection.count} 张` : "未选择"}</span>
            {localUploadSelection ? <span>{formatFileSize(localUploadSelection.totalBytes)}</span> : null}
          </div>
          <div className="toolbar">
            <button className="secondary-button" disabled={localUploadPicking} onClick={chooseLocalUploadFiles}>
              <Images size={15} /> 选择图片
            </button>
            <button className="secondary-button" disabled={localUploadPicking} onClick={chooseLocalUploadFolder}>
              <Upload size={15} /> 选择文件
            </button>
            <button className="primary-button" disabled={localUploadPicking || !localUploadSelection || localUploadSelection.count === 0 || !selectedProductImageRuleId || localUploadExceedsStorage} onClick={startLocalUploadJob}>
              <Upload size={15} /> 后台上传
            </button>
          </div>
          {localUploadSelection ? (
            <div className="upload-task-meta">
              <strong>已选择 {localUploadSelection.count} 张图片，启动后可切换页面，进度在任务记录中查看</strong>
              <span>{localUploadSelection.sampleNames.slice(0, 10).join("?")}{localUploadSelection.sampleNames.length > 10 ? " ..." : ""}</span>
            </div>
          ) : (
            <div className="upload-task-meta">
              <span className="muted">推荐客户端用户使用；图片由客户端直传 OSS，服务器只保存图片记录</span>
            </div>
          )}
        </div>
        <GalleryUploadJobsPanel
          jobs={galleryUploadJobs}
          onOpenJobs={() => onNavigate?.("jobs")}
          onRefresh={refreshGalleryUploadJobs}
          onMessage={onMessage}
        />
        {uploadFiles.length > 0 ? (
          <div className="upload-file-strip">
            <strong>待上${uploadFiles.length} </strong>
            <span>
              预计 {uploadPlan.totalBatches} · 总大${formatFileSize(uploadPlan.totalBytes)} · 最大单${formatFileSize(uploadPlan.largestBatchBytes)}
              {uploadFiles.slice(0, 10).map(fileDisplayName).join("?")}{uploadFiles.length > 10 ? " ..." : ""}
            </span>
          </div>
        ) : null}
        {uploadTask ? <UploadTaskStatusPanel task={uploadTask} /> : null}
        {uploadProgress ? (
          <div className="upload-progress-block">
            <div className="gallery-summary-row">
              <span>${uploadProgress.currentBatch} / {uploadProgress.totalBatches} </span>
              {uploadProgress.currentBatchFiles ? <span>本批 {uploadProgress.currentBatchFiles} · {formatFileSize(uploadProgress.currentBatchBytes ?? 0)}</span> : null}
              <span>已成${uploadProgress.uploaded} </span>
              <span>失败 {uploadProgress.failed} </span>
            </div>
            <div className="progress">
              <span style={{ width: `${Math.round((uploadProgress.currentBatch / uploadProgress.totalBatches) * 100)}%` }} />
            </div>
          </div>
        ) : null}
        {visibleUploadErrors.length > 0 ? (
          <div className="upload-error-list" role="status">
            <strong>失败原因</strong>
            <ul>
              {visibleUploadErrors.slice(0, 10).map((error, index) => (
                <li key={`${error.filename}-${index}`}>
                  <span>{error.filename}</span>
                  <em>{error.message}</em>
                </li>
              ))}
            </ul>
            {visibleUploadErrors.length > 10 ? <span className="muted">还有 {visibleUploadErrors.length - 10} 条失败记录未显示</span> : null}
          </div>
        ) : null}
        {uploadHistory.length > 0 ? <UploadHistoryPanel items={uploadHistory} /> : null}
        <p className="muted upload-note">文件夹里同名图片会按同一个货号处理；PNG、JPG、JPEG、WebP 文件会自动跳过</p>
      </div> : !isPending ? (
        <div className="gallery-featured-note">
          <strong>{isProcessing ? "上传中的商品会继续处理" : isUploaded ? "已上传图片只展示进入店铺记录的图片" : "精品图库展示公共推荐图片"}</strong>
          <span>{isProcessing ? "这里展示已经进入自动上架流程的图片，可查看套图、标题和上架包处理进度。" : isUploaded ? "这些图片已经记录到店铺上架状态，后续不会再重复上传到其他店铺。" : "推荐依据来自全平台订单货号聚合信号，不展示上传用户、店铺、订单号和销售额。"}</span>
        </div>
      ) : null}

      {isUploaded && repairImageProgress ? (
        <div className={`upload-progress-block repair-progress-block ${repairImageProgress.phase}`}>
          <div className="gallery-summary-row">
            <span>{repairImageProgress.message}</span>
            {typeof repairImageProgress.scanned === "number" ? <span>已扫${repairImageProgress.scanned}{typeof repairImageProgress.total === "number" ? ` / ${repairImageProgress.total}` : ""}</span> : null}
            {typeof repairImageProgress.skipped === "number" && repairImageProgress.skipped > 0 ? <span>跳过 {repairImageProgress.skipped}</span> : null}
            {repairImageProgress.job ? <span>{statusText(repairImageProgress.job.status)} {repairImageProgress.job.progress}%</span> : null}
            {repairImageProgress.job?.successCount !== undefined || repairImageProgress.job?.failedCount !== undefined ? (
              <span>成功 {repairImageProgress.job.successCount ?? 0} / 失败 {repairImageProgress.job.failedCount ?? 0}</span>
            ) : null}
          </div>
          <div className="progress">
            <span style={{ width: `${repairProgressPercent(repairImageProgress)}%` }} />
          </div>
          <div className="toolbar">
            {repairImageProgress.job ? (
              <button className="secondary-button" onClick={() => onNavigate?.("jobs")}>
                查看任务日志
              </button>
            ) : null}
            {repairImageProgress.phase !== "running" && repairImageProgress.phase !== "scanning" ? (
              <button className="secondary-button" onClick={() => setRepairImageProgress(null)}>
                收起
              </button>
            ) : null}
          </div>
        </div>
      ) : null}

      {isPending ? (
        <div className="listing-workflow-panel">
          <div className="panel-header compact-panel-header">
            <div>
              <h3>上架准备</h3>
              <p className="muted">先选比例、样机和图片，再把图片分配给店铺；同一张原图只能进入一个店铺任务</p>
            </div>
            <div className="toolbar">
              <button className="secondary-button" disabled={loading || listingSetupPhase === "loading"} onClick={() => saveListingPreferences("manual").catch((error) => onMessage(error instanceof Error ? error.message : String(error)))}>
                保存上架设置
              </button>
            </div>
          </div>

          <div className="listing-summary-strip">
            <span>{autoListingText.title}{"\u76ee\u6807"} {autoListingSummary.target}</span>
            <span>{"\u5df2\u5b8c\u6210"} {autoListingSummary.completed}</span>
            <span>{"\u5904\u7406\u4e2d"} {autoListingSummary.processing}</span>
            <span>{"\u5931\u8d25"} {autoListingSummary.failed}</span>
            <span>{"\u5269\u4f59"} {autoListingSummary.remaining}</span>
            <span>{"\u5df2\u9009\u4e2d"} {selectedAssets.length} {"\u5f20"}</span>
            <span>已套${selectedListingReadyAssets.length} </span>
            {selectedBlockedListingCount > 0 ? <span className="warn-text">{selectedBlockedListingCount} 张会自动补套</span> : null}
            <span>当前商品：{selectedProductRuleText || "请选择商品类型和图片比例"}</span>
            {dailyListingStatsLoading ? <span>正在刷新今日额度</span> : null}
            {dailyListingStatsError ? <span className="warn-text">{"\u989d\u5ea6\u67e5\u8be2\u5931\u8d25\uff0c\u63d0\u4ea4\u65f6\u670d\u52a1\u5668\u4f1a\u6700\u7ec8\u6821\u9a8c"}</span> : null}
            {selectedListingQuotaWarnings.length > 0 ? <span className="warn-text">额度不足：{selectedListingQuotaWarnings.join("")}</span> : null}
          </div>

          <div className="listing-config-grid">
            <div className="listing-config-block">
              <div className="listing-block-head">
                <strong>店铺与商品模</strong>
                <button className="secondary-button" disabled={loading || activeShopListingConfigs.length >= listingShopOptions.length} onClick={addListingShop}>
                  <Plus size={14} /> 添加店铺
                </button>
              </div>
              <div className="listing-shop-list">
                {activeShopListingConfigs.map((config) => {
                  const shopTemplates = productTemplates.filter((template) => !(template.shared || template.externalShopId === SHARED_PRODUCT_TEMPLATE_SHOP_ID) && template.externalShopId === config.externalShopId);
                  const otherTemplates = productTemplates.filter((template) => !(template.shared || template.externalShopId === SHARED_PRODUCT_TEMPLATE_SHOP_ID) && template.externalShopId !== config.externalShopId);
                  const productTemplateUnavailable = Boolean(config.productTemplateId && !productTemplates.some((template) => template.id === config.productTemplateId));
                  const localTemplateUnavailable = Boolean(config.localTemplateId && !localProductTemplates.some((template) => template.id === config.localTemplateId));
                  const quota = listingQuotaByShopId.get(config.externalShopId);
                  return (
                    <div className="listing-shop-row" key={config.externalShopId}>
                      <div className="field">
                        <label>店铺</label>
                        <select
                          value={config.externalShopId}
                          onChange={(event) => changeListingShop(config.externalShopId, event.target.value)}
                        >
                          {listingShopOptions.map((shop) => (
                            <option
                              key={shop.id}
                              value={shop.id}
                              disabled={shopListingConfigs.some((item) => item.externalShopId === shop.id && item.externalShopId !== config.externalShopId)}
                            >
                              {shop.name}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div className="field">
                        <label>商品模板</label>
                        <select value={config.productTemplateId} onChange={(event) => selectProductTemplateForShop(config.externalShopId, event.target.value)}>
                          <option value="">新建或选择模板</option>
                          {productTemplateUnavailable ? (
                            <option value={config.productTemplateId} disabled>
                              {config.productTemplateName || config.productTemplateId}（模板不可用）
                            </option>
                          ) : null}
                          {sharedProductTemplates.length > 0 ? (
                            <optgroup label="所有店铺共享">
                              {sharedProductTemplates.map((template) => (
                                <option key={template.id} value={template.id}>{template.name}</option>
                              ))}
                            </optgroup>
                          ) : null}
                          {shopTemplates.length > 0 ? (
                            <optgroup label="当前店铺模板">
                              {shopTemplates.map((template) => (
                                <option key={template.id} value={template.id}>{template.name}</option>
                              ))}
                            </optgroup>
                          ) : null}
                          {otherTemplates.length > 0 ? (
                            <optgroup label="其他店铺模板">
                              {otherTemplates.map((template) => (
                                <option key={template.id} value={template.id}>{template.name}</option>
                              ))}
                            </optgroup>
                          ) : null}
                        </select>
                        {productTemplateUnavailable ? <span className="warn-text">云端模板不可用</span> : null}
                      </div>
                      <div className="field">
                        <label>模板名称</label>
                        <input
                          value={config.newTemplateName}
                          onChange={(event) => updateListingShopConfig(config.externalShopId, {
                            newTemplateName: event.target.value,
                            productTemplateName: event.target.value,
                          })}
                          placeholder="例如：方巾通用模板"
                        />
                      </div>
                      <div className="field">
                        <label>类目说明</label>
                        <input
                          value={config.categoryLabel}
                          onChange={(event) => updateListingShopConfig(config.externalShopId, { categoryLabel: event.target.value })}
                          placeholder="例如：头</ 方巾"
                        />
                      </div>
                      <div className="field">
                        <label>本地 Ozon 模板</label>
                        <select
                          value={config.localTemplateId}
                          onChange={(event) => updateListingShopConfig(config.externalShopId, { localTemplateId: event.target.value })}
                        >
                          <option value="">选择正式上架模板</option>
                          {localTemplateUnavailable ? (
                            <option value={config.localTemplateId} disabled>
                              {config.localTemplateId}（模板不可用）
                            </option>
                          ) : null}
                          {localProductTemplates.map((template) => (
                            <option key={template.id} value={template.id}>{template.name}</option>
                          ))}
                        </select>
                        {localTemplateUnavailable ? <span className="warn-text">本地 Ozon 模板不可用</span> : null}
                      </div>
                      <div className="field">
                        <label>今日上架限额</label>
                        <input
                          type="number"
                          min={1}
                          max={10000}
                          value={config.dailyListingLimit}
                          onChange={(event) => updateListingShopConfig(config.externalShopId, {
                            dailyListingLimit: normalizePositiveInt(event.target.value, 300),
                          })}
                        />
                      </div>
                      <div className="field">
                        <label>今日剩余额度</label>
                        <div className={quota && quota.overBy > 0 ? "listing-quota-box warn" : "listing-quota-box"}>
                          <strong>{quota ? quota.remaining : config.dailyListingLimit}</strong>
                          <span>
                            {"\u5df2\u4e0a\u67b6"} {quota?.listedCount ?? 0}
                            {quota ? `\uFF0C\u5DF2\u5360\u7528 ${quota.reservedCount}` : "\uFF0C\u5DF2\u5360\u7528 0"}
                            {quota && quota.pendingCount > 0 ? `\uFF0C\u5904\u7406\u4E2D\u5360\u7528 ${quota.pendingCount}` : ""}
                            {quota && quota.selectedCount > 0 ? `\uFF0C\u672C\u6B21\u9009\u62E9 ${quota.selectedCount}` : ""}
                          </span>
                        </div>
                      </div>
                      <div className="auto-option-row">
                        <label>
                          <input
                            type="checkbox"
                            checked={config.productTemplateShared}
                            onChange={(event) => updateListingShopConfig(config.externalShopId, { productTemplateShared: event.currentTarget.checked })}
                          />
                          商品模板所有店铺共
                        </label>
                      </div>
                      <div className="listing-shop-actions">
                        <button className="secondary-button" disabled={loading} onClick={() => saveProductTemplateForShop(config)}>保存模板</button>
                        <button className="secondary-button" disabled={loading || activeShopListingConfigs.length <= 1} onClick={() => removeListingShop(config.externalShopId)}>移除</button>
                      </div>
                    </div>
                  );
                })}
                {activeShopListingConfigs.length === 0 ? <span className="muted">请先同步店铺后再创建上架任务</span> : null}
              </div>
            </div>

            <div className="listing-config-block">
              <div className="listing-block-head">
                <strong>标题提示</strong>
                <button className="secondary-button" disabled={loading} onClick={saveTitlePrompt}>保存提示</button>
              </div>
              <div className="form-grid compact-form-grid listing-prompt-grid">
                <div className="field">
                  <label>已保存模</label>
                  <select value={selectedTitlePromptId} onChange={(event) => selectTitlePromptTemplate(event.target.value)}>
                    <option value="">新建提示</option>
                    {titlePromptTemplates.map((template) => (
                      <option key={template.id} value={template.id}>{template.name}</option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>模板名称</label>
                  <input value={titlePromptName} onChange={(event) => setTitlePromptName(event.target.value)} />
                </div>
                <div className="field full">
                  <label>提示</label>
                  <textarea rows={5} value={titlePrompt} onChange={(event) => setTitlePrompt(event.target.value)} />
                </div>
              </div>
              <div className="listing-help-row">
                <span>可用变量：{"{sku}"}、{"{source_url}"}、{"{image_url}"}</span>
              </div>
            </div>
          </div>

          {selectedAssets.length > 0 ? (
            <div className="listing-draft-table">
              <div className="listing-block-head">
                <strong>已选图片上架信</strong>
                <span className="muted">一键上架会自动补齐套图和标题；需要指定店铺时可先在这里调整</span>
              </div>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>货号</th>
                      <th>店铺</th>
                      <th>套图</th>
                      <th>标题</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selectedAssets.map((asset, index) => {
                      const fallbackShopId = activeShopListingConfigs[index % Math.max(activeShopListingConfigs.length, 1)]?.externalShopId || "";
                      const draft = listingDrafts[asset.id] ?? createDefaultListingDraft(fallbackShopId);
                      const results = mockupResultsForDisplay(asset, selectedMockupTemplate);
                      return (
                        <tr key={asset.id}>
                          <td>
                            <strong>{asset.sku}</strong>
                            {asset.listingStatus ? <div className="muted">{listingStatusText(asset)}</div> : null}
                          </td>
                          <td>
                            <select value={draft.externalShopId} onChange={(event) => updateListingDraft(asset.id, { externalShopId: event.target.value })}>
                              {activeShopListingConfigs.map((config) => (
                                <option key={config.externalShopId} value={config.externalShopId}>{selectedShopNameById.get(config.externalShopId) ?? config.externalShopId}</option>
                              ))}
                            </select>
                          </td>
                          <td>
                            <span>{results.length > 0 ? `${results.length} 张` : "一键上架时自动生成"}</span>
                            {results[0] ? <img className="listing-mini-thumb" src={results[0].thumbUrl || results[0].publicUrl} alt={asset.sku} loading="lazy" decoding="async" /> : null}
                          </td>
                          <td>
                            <div className="listing-title-cell">
                              <input
                                value={draft.title}
                                onChange={(event) => updateListingDraft(asset.id, { title: event.target.value, titleStatus: event.target.value.trim() ? "done" : "idle" })}
                                placeholder={draft.titleStatus === "generating" ? "标题生成.." : "一键上架时自动生成标题"}
                              />
                            </div>
                            {draft.titleError ? <span className="warn-text">{draft.titleError}</span> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {listingProgress ? (
            <div className="upload-progress-block listing-progress-block">
              <div className="gallery-summary-row">
                <span>{listingProgress.stage}</span>
                <span>{listingProgress.done}/{listingProgress.total}</span>
                <span>失败 {listingProgress.failed}</span>
                {listingProgress.currentSku ? <span>{listingProgress.currentSku}</span> : null}
              </div>
              <div className="progress">
                <span style={{ width: `${Math.round((listingProgress.done / Math.max(1, listingProgress.total)) * 100)}%` }} />
              </div>
            </div>
          ) : null}

          {lastListingBatch && !isPending ? (
            <div className="listing-result-box">
              <div>
                <strong>上架包包含 {lastListingBatch.imageSets.length} 个商品 / {lastListingBatch.shopTargets.length} 个店铺</strong>
                <span className="muted">当前状态：{lastListingBatch.status === "uploaded" ? "已提交" : "待提交"} · {formatDate(lastListingBatch.updatedAt)}，可继续自动提交到 Ozon。</span>
              </div>
              <div className="toolbar">
                <button className="primary-button" disabled={loading || lastListingBatch.status === "uploaded"} onClick={startAutoListing} title={submitListingDisabledReason}>
                  继续自动上架任务
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {isPending ? (
        <div className="gallery-batch-bar">
          <div>
            <strong>已选择 {selectedAssets.length} 张原图</strong>
            <span>
              当前页还有 {pageAssetsWithoutCurrentMockup.length} 张未套{currentMockupTemplateName}
              已选中 {selectedAssetsWithoutCurrentMockup.length} 张可生成{selectedRenderedCount > 0 ? `${selectedRenderedCount} 张会跳过` : ""}
              可删除 {selectedDeletableAssets.length} 张
            </span>
            {batchMockupProgress ? (
              <em>正在处理 {batchMockupProgress.currentSku}，进度 {batchMockupProgress.done}/{batchMockupProgress.total}，失败 {batchMockupProgress.failed}</em>
            ) : null}
          </div>
          <div className="toolbar">
            <button className="secondary-button" disabled={loading || assets.length === 0} onClick={selectCurrentPageAssets}>
              选择本页
            </button>
            <button className="secondary-button" disabled={loading || selectedAssets.length === 0} onClick={() => setSelectedAssetIds(new Set())}>
              清空选择
            </button>
            <button className={bulkDeleteConfirm ? "danger-button" : "secondary-button"} disabled={loading || selectedDeletableAssets.length === 0} onClick={deleteSelectedAssets}>
              <Trash2 size={15} /> {bulkDeleteConfirm ? `确认删除 ${selectedDeletableAssets.length} 张` : "批量删除"}
            </button>
          </div>
        </div>
      ) : null}

      {isUploaded ? (
        <div className="gallery-batch-bar">
          <div>
            <strong>已选择 {selectedUploadedAssets.length} 个已上传商品</strong>
            <span>将使用当前样机 {currentMockupTemplateName} 重新生成套图后更新 Ozon 商品图片</span>
          </div>
          <div className="toolbar">
            <button className="secondary-button" disabled={loading || selectableAssets.length === 0} onClick={selectCurrentPageAssets}>
              选择本页
            </button>
            <button className="secondary-button" disabled={loading || selectedUploadedAssets.length === 0} onClick={() => setSelectedAssetIds(new Set())}>
              清空选择
            </button>
            <button className="primary-button" disabled={loading || selectedUploadedAssets.length === 0} onClick={updateSelectedUploadedProductImages}>
              <Wand2 size={15} /> 更新已选商品图片
            </button>
          </div>
        </div>
      ) : null}

      {isPending && mockupNotice ? (
        <div className={`mockup-feedback ${mockupNotice.type}`}>
          {mockupNotice.type === "success" ? <CheckCircle2 size={16} /> : mockupNotice.type === "error" ? <AlertCircle size={16} /> : <LoaderCircle size={16} className="spin-icon" />}
          <strong>{mockupNotice.type === "success" ? "处理完成" : mockupNotice.type === "error" ? "处理失败" : "处理中"}</strong>
          <span>{mockupNotice.message}</span>
        </div>
      ) : null}

      {isPending && mockupErrors.length > 0 ? (
        <div className="upload-error-list mockup-error-list" role="status">
          <strong>套图失败明细</strong>
          <ul>
            {mockupErrors.slice(0, 10).map((error, index) => (
              <li key={`${error.filename}-${index}`}>
                <span>{error.filename}</span>
                <em>{error.message}</em>
              </li>
            ))}
          </ul>
          {mockupErrors.length > 10 ? <span className="muted">还有 {mockupErrors.length - 10} 条失败记录未显示</span> : null}
        </div>
      ) : null}

      {!isUpload ? <>
      <div className="gallery-summary-row">
        <span>{displayTotal} 张图</span>
        <span>{page} / {pageCount}</span>
        <span>当前 {visibleAssets.length} 张</span>
        {isFeatured ? <span>按出单热度排</span> : null}
      </div>

      {viewMode === "grid" ? (
        <div className="cloud-gallery-grid">
          {visibleAssets.map((asset) => (
            <div className={isPending ? "cloud-asset-card" : isProcessing ? "cloud-asset-card processing-card" : "cloud-asset-card image-only-card"} key={asset.id}>
              {(isPending || isUploaded) ? (
                <label className="asset-select-row">
                  <input
                    type="checkbox"
                    checked={selectedAssetIds.has(asset.id)}
                    disabled={isPending && Boolean(asset.listingStatus)}
                    onChange={(event) => toggleAssetSelection(asset.id, event.currentTarget.checked)}
                  />
                  <span>{asset.listingStatus ? "已使用" : "选择"}</span>
                </label>
              ) : null}
              <div className={isPending ? "gallery-asset-media" : "gallery-asset-media image-only-media"}>
                <div className="gallery-source-frame">
                  <span className="gallery-media-label">原图</span>
                  <img className="gallery-source-image" src={asset.thumbUrl || asset.publicUrl} alt={asset.sku} loading="lazy" decoding="async" />
                </div>
                {isPending || isProcessing ? (
                  <div className="gallery-mockup-stack">
                    <AssetGeneratedTitle title={assetDisplayTitle(asset, listingDrafts[asset.id])} />
                    <MockupInlineResults
                      asset={asset}
                      templateId={selectedMockupTemplate}
                      templateName={currentMockupTemplateName}
                      isRendering={renderingAssetId === asset.id}
                      onOpen={() => setPreviewAsset(asset)}
                    />
                  </div>
                ) : null}
              </div>
              <strong>{asset.sku}</strong>
              {asset.listingStatus ? <span className="listing-status-pill">{listingStatusText(asset)}</span> : null}
                  {isProcessing ? (
                    <ProcessingProgressCell
                      asset={asset}
                      templateId={selectedMockupTemplate}
                      template={currentMockupTemplate}
                      preparationTask={activePreparationTaskByAssetId.get(asset.id)}
                      compact
                    />
                  ) : null}
              {isPending ? <span>{assetProductRuleLabel(asset)} · {asset.width}x{asset.height}</span> : null}
              {isPending ? <span>{formatSize(asset.sizeBytes)} · {formatDate(asset.createdAt)}</span> : null}
              <div className="gallery-card-actions">
                <button className="secondary-button" onClick={() => copySku(asset)}>
                  <Copy size={14} /> 货号
                </button>
                {isPending ? (
                  <>
                    <button className="secondary-button" disabled={!hasMockupResults(asset, selectedMockupTemplate)} onClick={() => setPreviewAsset(asset)}>
                      查看详情
                    </button>
                  </>
                ) : (
                  <>
                    {isProcessing ? (
                      <button className="secondary-button" disabled={!hasMockupResults(asset, selectedMockupTemplate)} onClick={() => setPreviewAsset(asset)}>
                        查看进度
                      </button>
                    ) : null}
                    <a className="secondary-button gallery-card-download-action" href={asset.publicUrl} download target="_blank" rel="noreferrer">下载</a>
                  </>
                )}
                {!isProcessing ? (
                  <button className={deleteConfirmAssetId === asset.id ? "danger-button" : "secondary-button"} disabled={loading} onClick={() => deleteAsset(asset)}>
                    <Trash2 size={14} /> {deleteConfirmAssetId === asset.id ? "确认删除" : "删除"}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
          {visibleAssets.length === 0 ? <GalleryEmptyState tab={tab} /> : null}
        </div>
      ) : (
        <div className="table-wrap gallery-list-wrap">
          <table className={isPending ? "gallery-list-table pending-list-table" : isProcessing ? "gallery-list-table processing-list-table" : "gallery-list-table"}>
            <thead>
              <tr>
                {(isPending || isUploaded) ? <th className="gallery-list-select-cell">选择</th> : null}
                <th className="gallery-list-image-cell">图片</th>
                <th className="gallery-list-sku-cell">货号</th>
                {isProcessing ? <th className="gallery-list-progress-cell">处理进度</th> : null}
                <th className="gallery-list-ratio-cell">比例</th>
                <th className="gallery-list-size-cell">尺寸</th>
                <th className="gallery-list-file-size-cell">大小</th>
                <th className="gallery-list-time-cell">上传时间</th>
                {isFeatured ? <th>推荐</th> : null}
                <th className="gallery-list-action-cell">操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleAssets.map((asset) => (
                <tr key={asset.id}>
                  {(isPending || isUploaded) ? (
                    <td className="gallery-list-select-cell">
                      <input
                        type="checkbox"
                        checked={selectedAssetIds.has(asset.id)}
                        disabled={isPending && Boolean(asset.listingStatus)}
                        onChange={(event) => toggleAssetSelection(asset.id, event.currentTarget.checked)}
                        aria-label={`选择 ${asset.sku}`}
                      />
                    </td>
                  ) : null}
                  <td className="gallery-list-image-cell"><img className="gallery-list-thumb" src={asset.thumbUrl || asset.publicUrl} alt={asset.sku} loading="lazy" decoding="async" /></td>
                  <td className="gallery-list-sku-cell">
                    <strong>{asset.sku}</strong>
                    <div className="muted">{asset.sourceFilename}</div>
                    {asset.listingStatus ? <div className="listing-status-pill inline">{listingStatusText(asset)}</div> : null}
                  </td>
                  {isProcessing ? (
                    <td className="gallery-list-progress-cell">
                      <ProcessingProgressCell
                        asset={asset}
                        templateId={selectedMockupTemplate}
                        template={currentMockupTemplate}
                        preparationTask={activePreparationTaskByAssetId.get(asset.id)}
                      />
                    </td>
                  ) : null}
                  <td className="gallery-list-ratio-cell"><AssetRatioBadge asset={asset} /></td>
                  <td className="gallery-list-size-cell">{asset.width}x{asset.height}</td>
                  <td className="gallery-list-file-size-cell">{formatSize(asset.sizeBytes)}</td>
                  <td className="gallery-list-time-cell">{formatDate(asset.createdAt)}</td>
                  {isFeatured ? <td>{featuredText(asset)}</td> : null}
                  <td className="gallery-list-action-cell">
                    <div className="toolbar">
                      <button className="secondary-button" onClick={() => copySku(asset)}>
                        <Copy size={14} /> 货号
                      </button>
                      {isPending ? (
                        <>
                          <button className="secondary-button" disabled={!hasMockupResults(asset, selectedMockupTemplate)} onClick={() => setPreviewAsset(asset)}>
                            查看详情
                          </button>
                        </>
                      ) : (
                        <>
                          {isProcessing ? (
                            <button className="secondary-button" disabled={!hasMockupResults(asset, selectedMockupTemplate)} onClick={() => setPreviewAsset(asset)}>
                              查看进度
                            </button>
                          ) : null}
                          <a className="secondary-button" href={asset.publicUrl} download target="_blank" rel="noreferrer">下载</a>
                        </>
                      )}
                      {!isProcessing ? (
                        <button className={deleteConfirmAssetId === asset.id ? "danger-button" : "secondary-button"} disabled={loading} onClick={() => deleteAsset(asset)}>
                          <Trash2 size={14} /> {deleteConfirmAssetId === asset.id ? "确认删除" : "删除"}
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {visibleAssets.length === 0 ? <tr><td colSpan={(isPending || isUploaded) ? 8 : isProcessing ? 8 : isFeatured ? 8 : 7} className="muted">{emptyGalleryText(tab)}</td></tr> : null}
            </tbody>
          </table>
        </div>
      )}

      <div className="pagination-bar">
        <button className="secondary-button" disabled={loading || page <= 1} onClick={() => loadAssets(1)}>首页</button>
        <button className="secondary-button" disabled={loading || page <= 1} onClick={() => loadAssets(page - 1)}>上一页</button>
        <span>当前页 {visibleAssets.length} 张</span>
        <span>第 {page} / {pageCount} 页</span>
        <button className="secondary-button" disabled={loading || page >= pageCount} onClick={() => loadAssets(page + 1)}>下一页</button>
        <button className="secondary-button" disabled={loading || page >= pageCount} onClick={() => loadAssets(pageCount)}>末页</button>
      </div>
      </> : null}
      {previewAsset ? (
        <MockupPreviewDialog
          asset={previewAsset}
          templateId={selectedMockupTemplate}
          templateName={currentMockupTemplateName}
          onClose={() => setPreviewAsset(null)}
        />
      ) : null}
    </section>
  );
}

function MockupInlineResults({
  asset,
  templateId,
  templateName,
  isRendering,
  onOpen,
}: {
  asset: CloudAsset;
  templateId: string;
  templateName: string;
  isRendering: boolean;
  onOpen: () => void;
}) {
  const results = mockupResultsForDisplay(asset, templateId);
  if (results.length === 0) {
    return (
      <div className={`gallery-mockup-inline empty ${isRendering ? "is-loading" : ""}`}>
        <span className="mockup-inline-title">
          {isRendering ? <LoaderCircle size={14} className="spin-icon" /> : <Images size={14} />}
          {isRendering ? `${templateName}生成中` : `暂无${templateName}套图`}
        </span>
      </div>
    );
  }
  return (
    <button className={`gallery-mockup-inline ${isRendering ? "is-loading" : ""}`} onClick={onOpen} type="button" aria-label={`查看 ${asset.sku} 的${templateName}套图详情`}>
      <span className="mockup-inline-header">
        <span className="mockup-inline-title">
          {isRendering ? <LoaderCircle size={14} className="spin-icon" /> : <Images size={14} />}
          {isRendering ? "更新中" : `${templateName} ${results.length} 张`}
        </span>
        <span className="mockup-inline-action">查看</span>
      </span>
      <span className="mockup-inline-thumbs">
        {results.slice(0, 6).map((result) => (
          <img key={`${result.templateId}-${result.sceneIndex}-${result.id}`} src={result.thumbUrl || result.publicUrl} alt={`${result.templateName} ${result.sceneIndex}`} loading="lazy" decoding="async" />
        ))}
        {results.length > 6 ? <em>+{results.length - 6}</em> : null}
      </span>
    </button>
  );
}

function AssetGeneratedTitle({ title, compact = false }: { title: string; compact?: boolean }) {
  const text = title.trim();
  return (
    <div className={`asset-generated-title ${compact ? "compact" : ""} ${text ? "" : "empty"}`} title={text || "未生成标"}>
      {text ? (
        <>
          <span>标题</span>
          <strong>{text}</strong>
        </>
      ) : (
        <strong>未生成标</strong>
      )}
    </div>
  );
}

function AssetRatioBadge({ asset }: { asset: CloudAsset }) {
  const label = assetProductRuleLabel(asset);
  const [productType, aspectRatio] = label.includes(" · ")
    ? label.split(" · ", 2)
    : [label, asset.aspectRatio || ratioLabel(asset.ratioFamily)];
  return (
    <span className="asset-ratio-badge" title={label}>
      <strong>{aspectRatio}</strong>
      <em>{productType}</em>
    </span>
  );
}

function ListingReconciliationPanel({
  summary,
  shops,
  loading,
  error,
  onRefresh,
}: {
  summary: CloudListingReconciliationSummary | null;
  shops: CloudListingShopProgress[];
  loading: boolean;
  error: string;
  onRefresh: () => void;
}) {
  const total = shops.reduce((sum, shop) => sum + shop.total, 0);
  const completed = shops.reduce((sum, shop) => sum + shop.completedCount, 0);
  const failed = shops.reduce((sum, shop) => sum + shop.failedCount, 0);
  const processing = shops.reduce((sum, shop) => sum + shop.processingCount, 0);
  return (
    <div className="listing-reconciliation-panel">
      <div className="listing-reconciliation-head">
        <div>
          <h3>今日上传对账</h3>
          <p className="muted">
            已选进入上传流程的商品会按店铺展示，真正提交到 Ozon 后才计入今日上传。
          </p>
        </div>
        <div className="toolbar">
          {summary ? <span className="badge neutral">{summary.dateFrom === summary.dateTo ? summary.dateFrom : `${summary.dateFrom} 至 ${summary.dateTo}`}</span> : null}
          {loading ? <span className="badge neutral"><LoaderCircle size={14} className="spin-icon" /> 刷新中</span> : null}
          <button className="secondary-button" onClick={onRefresh} disabled={loading}>
            <RefreshCw size={15} /> 刷新对账
          </button>
        </div>
      </div>
      <div className="reconciliation-metrics">
        <div><span>进入流程</span><strong>{total}</strong></div>
        <div><span>已上架</span><strong>{completed}</strong></div>
        <div><span>处理中</span><strong>{processing}</strong></div>
        <div><span>失败</span><strong>{failed}</strong></div>
      </div>
      {error ? <div className="alert compact-alert">对账查询失败：{error}</div> : null}
      <div className="shop-progress-grid">
        {shops.map((shop) => (
          <div className="shop-progress-card" key={shop.externalShopId}>
            <div className="shop-progress-title">
              <strong>{shop.shopName || shop.externalShopId}</strong>
              <span>{shop.progress}%</span>
            </div>
            <div className="progress shop-progress-bar">
              <span style={{ width: `${shop.progress}%` }} />
            </div>
            <div className="shop-progress-stats">
              <span>总数 {shop.total}</span>
              <span>已上 {shop.completedCount}</span>
              <span>失败 {shop.failedCount}</span>
            </div>
            <div className="shop-stage-row">
              <span className={shop.mockupRunning > 0 ? "is-running" : ""}>套图 {shop.mockupDone}/{shop.total}</span>
              <span className={shop.titleRunning > 0 ? "is-running" : ""}>标题 {shop.titleDone}/{shop.total}</span>
              <span className={shop.listingRunning > 0 ? "is-running" : ""}>上架 {shop.listingDone}/{shop.total}</span>
            </div>
            <em>
              {shop.currentSku
                ? `正在处理 ${shop.currentSku} · ${listingStageLabel(shop.currentStage)}${listingStageMessage(shop.currentMessage)}`
                : shop.processingCount > 0
                  ? "等待后台继续处理"
                  : shop.failedCount > 0
                    ? "有失败商品，建议重试"
                    : "当前店铺已完成"}
            </em>
          </div>
        ))}
        {shops.length === 0 ? (
          <div className="shop-progress-empty">
            <strong>暂无今日上传批次</strong>
            <span>如果刚开始套图，等待本地准备任务启动后这里会显示店铺进度。</span>
          </div>
        ) : null}
      </div>
      {summary?.batches?.length ? (
        <div className="batch-reconciliation-list">
          <div className="listing-block-head">
            <strong>最近批次</strong>
            <span className="muted">按最近更新时间排序，显示前 6 个批次</span>
          </div>
          {summary.batches.slice(0, 6).map((batch) => (
            <div className="batch-reconciliation-row" key={batch.batchId}>
              <strong>{batch.mockupTemplateName || "上架批次"}</strong>
              <span>{batch.total} 个商品 / {batch.shopCount} 个店铺</span>
              <span>已上 {batch.completedCount} · 处理中 {batch.processingCount} · 失败 {batch.failedCount}</span>
              <em>{formatDate(batch.updatedAt)}</em>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ProcessingProgressCell({
  asset,
  templateId,
  template,
  preparationTask,
  compact = false,
}: {
  asset: CloudAsset;
  templateId: string;
  template?: CloudMockupTemplate;
  preparationTask?: LocalPreparationTask;
  compact?: boolean;
}) {
  const mockupDone = mockupResultsForDisplay(asset, templateId).length;
  const mockupTotal = Math.max(template?.sceneCount ?? mockupDone, mockupDone, 1);
  const title = assetDisplayTitle(asset);
  const status = asset.listingStatus;
  const preparationStageProgress = buildPreparationStageProgress(preparationTask, mockupDone, mockupTotal, Boolean(title));
  const stageProgress = status?.stageProgress ?? preparationStageProgress;
  const overallProgress = listingOverallProgress(asset, mockupDone, mockupTotal, Boolean(title));
  const visibleOverallProgress = status
    ? overallProgress
    : listingPreparationOverallProgress(preparationTask, overallProgress);
  const stages = listingStageRows(stageProgress, {
    mockupDone,
    mockupTotal,
    titleDone: Boolean(title),
    listingDone: status?.status === "uploaded" || status?.stage === "listing" || overallProgress >= 60,
    currentStage: status?.stage,
  });
  const statusText = status?.stageMessage
    ? `${listingStageLabel(status.stage)}${listingStageMessage(status.stageMessage)}`
    : status?.batchId
      ? `上架${status.batchId.slice(0, 8)}`
      : preparationTask?.progress?.message || preparationTask?.error || "本地后台处理";
  return (
    <div className={`processing-progress-cell ${compact ? "compact" : ""}`}>
      <div className="processing-overall-row">
        <span>总进</span>
        <strong>{visibleOverallProgress}%</strong>
        <span className="mini-progress"><i style={{ width: `${visibleOverallProgress}%` }} /></span>
      </div>
      {stages.map((stage) => (
        <div key={stage.key}>
          <span>{stage.label}</span>
          <strong>{stage.text}</strong>
        </div>
      ))}
      <em>{statusText}</em>
    </div>
  );
}

function MockupThumbStrip({
  asset,
  templateId,
  templateName,
  isRendering = false,
  onOpen,
  compact = false,
}: {
  asset: CloudAsset;
  templateId: string;
  templateName: string;
  isRendering?: boolean;
  onOpen: () => void;
  compact?: boolean;
}) {
  const results = mockupResultsForDisplay(asset, templateId);
  if (results.length === 0) {
    return compact ? (
      <div className={`mockup-thumb-strip empty compact ${isRendering ? "is-loading" : ""}`}>
        {isRendering ? <LoaderCircle size={14} className="spin-icon" /> : null}
        <span>{isRendering ? "生成中" : `暂无${templateName}套图`}</span>
      </div>
    ) : (
      <div className={`mockup-thumb-strip empty ${isRendering ? "is-loading" : ""}`}>
        {isRendering ? <LoaderCircle size={14} className="spin-icon" /> : null}
        <span>{isRendering ? `${templateName}生成中` : `暂无${templateName}套图`}</span>
      </div>
    );
  }
  return (
    <button
      className={`mockup-thumb-strip ${compact ? "compact" : ""} ${isRendering ? "is-loading" : ""}`}
      onClick={onOpen}
      type="button"
      aria-label={`查看 ${asset.sku} 的${templateName}套图详情`}
    >
      {results.slice(0, 6).map((result) => (
        <img key={`${result.templateId}-${result.sceneIndex}-${result.id}`} src={result.thumbUrl || result.publicUrl} alt={`${result.templateName} ${result.sceneIndex}`} loading="lazy" decoding="async" />
      ))}
      {isRendering ? <LoaderCircle size={14} className="spin-icon" /> : null}
      <span>{templateName} {results.length} 张</span>
    </button>
  );
}

function MockupPreviewDialog({
  asset,
  templateId,
  templateName,
  onClose,
}: {
  asset: CloudAsset;
  templateId: string;
  templateName: string;
  onClose: () => void;
}) {
  const results = mockupResultsForDisplay(asset, templateId);
  const [activeResultKey, setActiveResultKey] = useState(() => (
    results[0] ? mockupResultKey(results[0]) : ""
  ));
  const activeResult = results.find((result) => mockupResultKey(result) === activeResultKey) ?? results[0];

  useEffect(() => {
    if (results.length === 0) {
      return;
    }
    if (!activeResult || !results.some((result) => mockupResultKey(result) === activeResultKey)) {
      setActiveResultKey(mockupResultKey(results[0]));
    }
  }, [activeResult, activeResultKey, results]);

  return (
    <div className="mockup-dialog-backdrop" role="presentation" onClick={onClose}>
      <div className="mockup-dialog" role="dialog" aria-modal="true" aria-label={`${asset.sku} ${templateName}套图详情`} onClick={(event) => event.stopPropagation()}>
        <div className="mockup-dialog-header">
          <div>
            <h3>{asset.sku} {templateName}套图详情</h3>
            <p className="muted">当前样机共 {results.length} 张效果图</p>
          </div>
          <button className="icon-button" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="mockup-dialog-source">
          <img src={asset.thumbUrl || asset.publicUrl} alt={asset.sku} />
          <div>
            <strong>原图</strong>
            <span>{asset.width}x{asset.height} · {formatSize(asset.sizeBytes)}</span>
          </div>
        </div>
        {results.length === 0 ? (
          <div className="mockup-detail-empty">
            <Images size={28} />
            <strong>还没有生成{templateName}套图</strong>
            <span>关闭弹窗后，先选中样机，再在图库卡片里点击生成即可</span>
          </div>
        ) : (
          <div className="mockup-dialog-content">
            {activeResult ? (
              <div className="mockup-large-panel">
                <div className="mockup-large-image">
                  <img src={activeResult.publicUrl} alt={`${activeResult.templateName} 场景 ${activeResult.sceneIndex} 放大图`} />
                </div>
                <div className="mockup-large-meta">
                  <div>
                    <strong>{activeResult.templateName} · 场景 {activeResult.sceneIndex}</strong>
                    <span>{activeResult.width}x{activeResult.height} · {formatSize(activeResult.sizeBytes)}</span>
                  </div>
                  <a className="secondary-button" href={activeResult.publicUrl} download target="_blank" rel="noreferrer">
                    <Download size={14} /> 下载当前
                  </a>
                </div>
              </div>
            ) : null}
            <div className="mockup-detail-grid">
              {results.map((result) => {
                const resultKey = mockupResultKey(result);
                const isActive = activeResult ? resultKey === mockupResultKey(activeResult) : false;
                return (
                  <article className={`mockup-detail-card ${isActive ? "active" : ""}`} key={`${result.templateId}-${result.sceneIndex}-${result.id}`}>
                    <button type="button" onClick={() => setActiveResultKey(resultKey)} aria-label={`放大查看 ${result.templateName} 场景 ${result.sceneIndex}`}>
                      <img src={result.thumbUrl || result.publicUrl} alt={`${result.templateName} 场景 ${result.sceneIndex}`} loading="lazy" decoding="async" />
                    </button>
                    <div className="mockup-detail-meta">
                      <strong>{result.templateName} · 场景 {result.sceneIndex}</strong>
                      <span>{result.width}x{result.height} · {formatSize(result.sizeBytes)}</span>
                      <a className="secondary-button" href={result.publicUrl} download target="_blank" rel="noreferrer">
                        <Download size={14} /> 下载
                      </a>
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function UploadTaskStatusPanel({ task }: { task: UploadTaskSnapshot }) {
  const percent = Math.min(100, Math.round((task.processed / Math.max(1, task.totalFiles)) * 100));
  return (
    <div className={`upload-progress-block upload-task-card ${task.status}`}>
      <div className="gallery-summary-row">
        <span>{uploadTaskStatusText(task.status)}</span>
        <span>{task.processed}/{task.totalFiles} </span>
        <span>成功 {task.uploaded}</span>
        <span>失败 {task.failed}</span>
        <span>共 {task.totalBatches} 批</span>
      </div>
      <div className="progress">
        <span style={{ width: `${task.status === "selected" ? 0 : percent}%` }} />
      </div>
      <div className="upload-task-meta">
        <strong>{task.message || "等待上传"}</strong>
        <span>{task.source === "folder" ? "文件夹" : "图片文件"} · 总大小 {formatFileSize(task.totalBytes)} · 更新 {formatDate(task.updatedAt)}</span>
        {task.currentBatch > 0 ? <span>当前批次 {task.currentBatch}/{task.totalBatches}{task.currentBatchFiles ? ` · ${task.currentBatchFiles} 张` : ""}</span> : null}
        {task.sampleFilenames.length > 0 ? <span title={task.sampleFilenames.join("、")}>文件：{task.sampleFilenames.slice(0, 6).join("、")}{task.sampleFilenames.length > 6 ? " ..." : ""}</span> : null}
      </div>
    </div>
  );
}

function GalleryUploadJobsPanel({
  jobs,
  onOpenJobs,
  onRefresh,
  onMessage,
}: {
  jobs: JobSummary[];
  onOpenJobs: () => void;
  onRefresh: () => Promise<void>;
  onMessage: (message: string) => void;
}) {
  const [page, setPage] = useState(1);
  const [selectedJobId, setSelectedJobId] = useState("");
  const [logs, setLogs] = useState<JobLog[]>([]);
  const [logPage, setLogPage] = useState(1);
  const [logLoading, setLogLoading] = useState(false);
  const [cancelingJobId, setCancelingJobId] = useState("");
  const pageSize = 10;
  const logPageSize = 10;
  const sortedJobs = useMemo(
    () => [...jobs].sort((left, right) => {
      const activeDiff = Number(!isActiveUploadJob(left)) - Number(!isActiveUploadJob(right));
      if (activeDiff !== 0) {
        return activeDiff;
      }
      return new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime();
    }),
    [jobs],
  );
  const totalPages = Math.max(1, Math.ceil(sortedJobs.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const visibleJobs = sortedJobs.slice((currentPage - 1) * pageSize, currentPage * pageSize);
  const totalLogPages = Math.max(1, Math.ceil(logs.length / logPageSize));
  const currentLogPage = Math.min(logPage, totalLogPages);
  const visibleLogs = logs.slice((currentLogPage - 1) * logPageSize, currentLogPage * logPageSize);
  const activeCount = sortedJobs.filter(isActiveUploadJob).length;
  const selectedJob = sortedJobs.find((job) => job.id === selectedJobId);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  useEffect(() => {
    if (logPage > totalLogPages) {
      setLogPage(totalLogPages);
    }
  }, [logPage, totalLogPages]);

  useEffect(() => {
    if (selectedJobId && !sortedJobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId("");
      setLogs([]);
      setLogPage(1);
    }
  }, [selectedJobId, sortedJobs]);

  useEffect(() => {
    if (!selectedJobId) {
      return undefined;
    }
    let disposed = false;
    const refreshLogs = async () => {
      try {
        const nextLogs = await api.listJobLogs(selectedJobId);
        if (!disposed) {
          setLogs(nextLogs.slice(-60));
          setLogLoading(false);
        }
      } catch {
        if (!disposed) {
          setLogLoading(false);
        }
      }
    };
    setLogLoading(true);
    void refreshLogs();
    const timer = window.setInterval(refreshLogs, selectedJob && isActiveUploadJob(selectedJob) ? 2000 : 5000);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [selectedJobId, selectedJob?.status]);

  const openLogs = (jobId: string) => {
    setSelectedJobId(jobId);
    setLogPage(1);
    setLogLoading(true);
  };

  const cancelJob = async (job: JobSummary) => {
    if (!isActiveUploadJob(job)) {
      return;
    }
    setCancelingJobId(job.id);
    try {
      const cancelled = await api.cancelJob(job.id);
      onMessage(cancelled ? `已取消图片上传任务：${job.title}` : "任务已经结束，无法继续取消");
      await onRefresh();
      if (selectedJobId === job.id) {
        const nextLogs = await api.listJobLogs(job.id).catch(() => []);
        setLogs(nextLogs.slice(-60));
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setCancelingJobId("");
    }
  };

  return (
    <div className="upload-history-list gallery-upload-jobs">
      <div className="panel-header compact-panel-header">
        <div>
          <h3>后台上传任务</h3>
          <p className="muted">{jobs.length} 个任务，{activeCount} 个执行中；客户端后台会继续上传，切换页面不会中断</p>
        </div>
        <div className="toolbar">
          <button className="secondary-button" onClick={() => onRefresh().catch((error) => onMessage(error instanceof Error ? error.message : String(error)))}>刷新</button>
          <button className="secondary-button" onClick={onOpenJobs}>任务记录</button>
        </div>
      </div>
      <div className="background-upload-list">
        {visibleJobs.map((job) => {
          const percent = Math.max(0, Math.min(100, job.progress ?? 0));
          const isActive = isActiveUploadJob(job);
          return (
            <article key={job.id} className={`upload-task-card compact-background-job ${job.status}`}>
              <div className="gallery-summary-row">
                <span>{statusText(job.status)}</span>
                <span>{percent}%</span>
                {typeof job.successCount === "number" ? <span>成功 {job.successCount}</span> : null}
                {typeof job.failedCount === "number" ? <span>失败 {job.failedCount}</span> : null}
                {isActive ? <span>后台执行</span> : null}
              </div>
              <div className="progress">
                <span style={{ width: `${percent}%` }} />
              </div>
              <div className="upload-task-meta">
                <strong>{job.title}</strong>
                <span>{job.lastError || job.error || `更新 ${formatDate(job.updatedAt)}`}</span>
              </div>
              <div className="background-upload-actions">
                <button className="secondary-button" onClick={() => openLogs(job.id)}>日志</button>
                {isActive ? (
                  <button className="danger-button" disabled={cancelingJobId === job.id} onClick={() => cancelJob(job)}>
                    {cancelingJobId === job.id ? "取消中" : "取消"}
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        {visibleJobs.length === 0 ? <div className="empty-state compact-empty-state"><strong>暂无后台上传任务</strong><span>选择图片或文件夹后，建议使用客户端后台上传</span></div> : null}
      </div>
      {totalPages > 1 ? (
        <div className="pagination-bar">
          <span>{currentPage} / {totalPages} 页，每页 10 个任务</span>
          <button className="secondary-button" disabled={currentPage <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>上一页</button>
          <button className="secondary-button" disabled={currentPage >= totalPages} onClick={() => setPage((value) => Math.min(totalPages, value + 1))}>下一页</button>
        </div>
      ) : null}
      {selectedJobId ? (
        <div className="gallery-upload-log-panel">
          <div className="panel-header compact-panel-header">
            <div>
              <h3>上传日志</h3>
              <p className="muted">{selectedJob?.title ?? selectedJobId} · {logs.length} 条 · {currentLogPage}/{totalLogPages}</p>
            </div>
            <button className="secondary-button" disabled={logLoading} onClick={() => openLogs(selectedJobId)}>{logLoading ? "读取中" : "刷新日志"}</button>
          </div>
          <div className="gallery-upload-log-list">
            {visibleLogs.length > 0 ? visibleLogs.map((log) => (
              <div key={log.id} className={`job-log-row ${log.level}`}>
                <span>{formatDate(log.createdAt)}</span>
                <strong>{log.level.toUpperCase()}</strong>
                <p>{log.message}</p>
              </div>
            )) : <span className="muted">{logLoading ? "正在读取日志..." : "暂无日志"}</span>}
          </div>
          {totalLogPages > 1 ? (
            <div className="pagination-bar">
              <button className="secondary-button" disabled={currentLogPage <= 1} onClick={() => setLogPage(1)}>首页</button>
              <button className="secondary-button" disabled={currentLogPage <= 1} onClick={() => setLogPage((value) => Math.max(1, value - 1))}>上一页</button>
              <span>{currentLogPage} / {totalLogPages} 页，每页 10 条日志</span>
              <button className="secondary-button" disabled={currentLogPage >= totalLogPages} onClick={() => setLogPage((value) => Math.min(totalLogPages, value + 1))}>下一页</button>
              <button className="secondary-button" disabled={currentLogPage >= totalLogPages} onClick={() => setLogPage(totalLogPages)}>末页</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function isActiveUploadJob(job: JobSummary) {
  return job.status === "queued" || job.status === "running";
}

function UploadHistoryPanel({ items }: { items: UploadTaskSnapshot[] }) {
  return (
    <div className="upload-history-list">
      <div className="panel-header compact-panel-header">
        <div>
          <h3>上传记录</h3>
          <p className="muted">最近完成的浏览器上传记录，便于排查失败文件</p>
        </div>
      </div>
      <div className="table-wrap compact-table">
        <table>
          <thead>
            <tr><th>状</th><th>数量</th><th>批次</th><th>来源</th><th>时间</th></tr>
          </thead>
          <tbody>
            {items.slice(0, 10).map((item) => (
              <tr key={item.id}>
                <td>{uploadTaskStatusText(item.status)}</td>
                <td>成功 {item.uploaded} / 失败 {item.failed} / 共 {item.totalFiles}</td>
                <td>{item.currentBatch || item.totalBatches}/{item.totalBatches}</td>
                <td>{item.source === "folder" ? "文件夹" : "图片文件"}</td>
                <td>{formatDate(item.finishedAt ?? item.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function GalleryEmptyState({ tab }: { tab: GalleryTab }) {
  return (
    <div className="empty-shop-state">
      {tab === "featured" ? <Star size={28} /> : <Upload size={28} />}
      <strong>{tab === "featured" ? "暂无精品图" : tab === "uploaded" ? "暂无已上传图片" : tab === "processing" ? "暂无上传中图片" : tab === "upload" ? "暂无上传任务" : "暂无待上传图片"}</strong>
      <span className="muted">{emptyGalleryText(tab)}</span>
    </div>
  );
}

function galleryModeTitle(tab: GalleryTab) {
  if (tab === "upload") return "图片上传";
  if (tab === "processing") return "上传";
  if (tab === "uploaded") return "已上传图";
  if (tab === "featured") return "精品图库";
  return "待上传图";
}

function defaultViewModeForTab(tab: GalleryTab): ViewMode {
  return tab === "featured" ? "grid" : "list";
}

function defaultPageSizeForTab(tab: GalleryTab, fallback: number) {
  return tab === "processing" || tab === "uploaded" ? 10 : fallback;
}

function galleryModeDescription(tab: GalleryTab) {
  if (tab === "upload") return "选择图片或文件夹后独立上传到云图库，页面切换后仍可回来查看当前进度和最近上传记录";
  if (tab === "processing") return "展示已经进入自动上架流程的图片，实时查看套图、标题和上架包处理进度";
  if (tab === "uploaded") return "展示已经记录到店铺上架状态的图片，方便按货号和店铺回查";
  if (tab === "featured") return "记录出过单货号的商品图片，用于参考和复用灵感";
  return "展示当前账号上传后还未进入店铺上架记录的图片，可生成套图并准备上架";
}

function emptyGalleryText(tab: GalleryTab) {
  if (tab === "upload") return "选择图片或文件夹后会显示批次、成功数、失败数和最近上传历史";
  if (tab === "featured") return "查询订单并同步出单货号后，系统会把匹配到图库的图片加入精品库";
  if (tab === "processing") return "选择图片生成上架包后会进入这里；上架成功后会自动移动到已上传图片";
  if (tab === "uploaded") return "确认上架包已上传后，图片会从待上传图片移动到这里";
  return "可以先批量上传图片，或调整比例、货号关键词和过滤条件";
}

function buildLocalPreparationShopProgress(
  tasks: LocalPreparationTask[],
  shopNameById: Map<string, string>,
): CloudListingShopProgress[] {
  const byShop = new Map<string, CloudListingShopProgress>();
  for (const task of tasks) {
    const fallbackShopId = task.context.shopListingConfigs[0]?.externalShopId || "";
    const total = Math.max(1, task.progress?.total ?? task.assetIds.length);
    const doneRatio = Math.max(0, Math.min(1, (task.progress?.done ?? 0) / total));
    const stage = task.progress?.stage ?? "queued";
    const stageRank = preparationStageRank(stage);
    const currentSku = task.progress?.currentSku ?? null;
    const isFailedTask = task.status === "failed" || stage === "failed";

    for (const assetId of task.assetIds) {
      const externalShopId = task.context.draftsByAssetId[assetId]?.externalShopId || fallbackShopId;
      if (!externalShopId) {
        continue;
      }
      const shop = byShop.get(externalShopId) ?? createEmptyShopProgress(externalShopId, shopNameById.get(externalShopId) ?? externalShopId);
      shop.total += 1;
      shop.processingCount += isFailedTask ? 0 : 1;
      shop.failedCount += isFailedTask ? 1 : 0;
      if (stageRank > preparationStageRank("mockup") || task.status === "prepared") {
        shop.mockupDone += 1;
      } else if (!isFailedTask && stage === "mockup") {
        shop.mockupRunning += 1;
        shop.mockupDone += doneRatio >= 1 ? 1 : 0;
      } else if (!isFailedTask && stage === "queued") {
        shop.mockupRunning += 1;
      }
      if (stageRank > preparationStageRank("title") || task.status === "prepared") {
        shop.titleDone += 1;
      } else if (!isFailedTask && stage === "title") {
        shop.titleRunning += 1;
      }
      if (!isFailedTask && stageRank >= preparationStageRank("submit")) {
        shop.listingRunning += 1;
      }
      if (!shop.currentSku) {
        shop.currentSku = currentSku;
        shop.currentStage = stage === "submit" ? "listing" : stage;
        shop.currentMessage = task.progress?.message ?? task.error ?? null;
      }
      shop.updatedAt = new Date(task.updatedAt).toISOString();
      shop.progress = Math.max(shop.progress, isFailedTask ? 100 : task.progress?.percent ?? localPreparationProgressPercent(stage));
      byShop.set(externalShopId, shop);
    }
  }
  return [...byShop.values()];
}

function mergeListingShopProgress(
  cloudShops: CloudListingShopProgress[],
  localShops: CloudListingShopProgress[],
  externalShopIdFilter?: string,
) {
  const byShop = new Map<string, CloudListingShopProgress>();
  for (const shop of cloudShops) {
    if (externalShopIdFilter && shop.externalShopId !== externalShopIdFilter) {
      continue;
    }
    byShop.set(shop.externalShopId, { ...shop, progress: clampPercent(shop.progress) });
  }
  for (const localShop of localShops) {
    if (externalShopIdFilter && localShop.externalShopId !== externalShopIdFilter) {
      continue;
    }
    const existing = byShop.get(localShop.externalShopId);
    if (!existing) {
      byShop.set(localShop.externalShopId, { ...localShop, progress: clampPercent(localShop.progress) });
      continue;
    }
    const total = existing.total + localShop.total;
    const weightedProgress = total > 0
      ? Math.round(((existing.progress * existing.total) + (localShop.progress * localShop.total)) / total)
      : Math.max(existing.progress, localShop.progress);
    byShop.set(localShop.externalShopId, {
      ...existing,
      total,
      completedCount: existing.completedCount + localShop.completedCount,
      failedCount: existing.failedCount + localShop.failedCount,
      processingCount: existing.processingCount + localShop.processingCount,
      mockupDone: existing.mockupDone + localShop.mockupDone,
      mockupRunning: existing.mockupRunning + localShop.mockupRunning,
      titleDone: existing.titleDone + localShop.titleDone,
      titleRunning: existing.titleRunning + localShop.titleRunning,
      listingDone: existing.listingDone + localShop.listingDone,
      listingRunning: existing.listingRunning + localShop.listingRunning,
      progress: clampPercent(weightedProgress),
      currentSku: localShop.currentSku ?? existing.currentSku,
      currentStage: localShop.currentStage ?? existing.currentStage,
      currentMessage: localShop.currentMessage ?? existing.currentMessage,
      updatedAt: latestDateString(existing.updatedAt, localShop.updatedAt),
    });
  }
  return [...byShop.values()].sort((left, right) => (
    right.processingCount - left.processingCount
    || right.mockupRunning - left.mockupRunning
    || (right.updatedAt?.localeCompare(left.updatedAt ?? "") ?? 0)
    || left.shopName.localeCompare(right.shopName, "zh-CN", { numeric: true, sensitivity: "base" })
  ));
}

function createEmptyShopProgress(externalShopId: string, shopName: string): CloudListingShopProgress {
  return {
    externalShopId,
    shopName,
    total: 0,
    completedCount: 0,
    failedCount: 0,
    processingCount: 0,
    mockupDone: 0,
    mockupRunning: 0,
    titleDone: 0,
    titleRunning: 0,
    listingDone: 0,
    listingRunning: 0,
    progress: 0,
  };
}

function preparationStageRank(stage?: string | null) {
  const order = ["queued", "mockup", "title", "batch", "submit", "prepared"];
  const index = order.indexOf(stage ?? "");
  return index >= 0 ? index : 0;
}

function localPreparationProgressPercent(stage?: string | null) {
  if (stage === "mockup") return 20;
  if (stage === "title") return 40;
  if (stage === "batch") return 60;
  if (stage === "submit") return 75;
  if (stage === "prepared") return 80;
  return 5;
}

function clampPercent(value: number | undefined) {
  return Math.max(0, Math.min(100, Math.round(Number(value ?? 0))));
}

function latestDateString(left?: string | null, right?: string | null) {
  if (!left) return right ?? null;
  if (!right) return left;
  return new Date(left).getTime() >= new Date(right).getTime() ? left : right;
}

function buildProcessingSummary(
  assets: CloudAsset[],
  templateId: string,
  template: CloudMockupTemplate | undefined,
  preparationTasks: LocalPreparationTask[] = [],
  queriedTotal: number | null = null,
  drafts: Record<string, ListingAssetDraft> = {},
) {
  const batchIds = new Set<string>();
  const shopIds = new Set<string>();
  const assetIds = new Set(assets.map((asset) => asset.id));
  const visibleTitleAssetIds = new Set<string>();
  let taskMockupDone = 0;
  let taskTitleDone = 0;
  let mockupDone = 0;
  let mockupImages = 0;
  let titleDone = 0;

  for (const asset of assets) {
    const results = mockupResultsForDisplay(asset, templateId);
    const expected = Math.max(template?.sceneCount ?? results.length, 1);
    mockupImages += results.length;
    if (results.length >= expected) {
      mockupDone += 1;
    }
    if (assetDisplayTitle(asset, drafts[asset.id])) {
      titleDone += 1;
      visibleTitleAssetIds.add(asset.id);
    }
    if (asset.listingStatus?.batchId) {
      batchIds.add(asset.listingStatus.batchId);
    }
    for (const shop of asset.listingStatus?.shops ?? []) {
      if (shop.externalShopId) {
        shopIds.add(shop.externalShopId);
      }
    }
  }

  for (const task of preparationTasks) {
    taskMockupDone += preparationMockupDone(task, assetIds);
    taskTitleDone += preparationTitleDone(task, visibleTitleAssetIds);
  }

  const taskAssetIds = new Set(preparationTasks.flatMap((task) => task.assetIds));
  const uniqueTotal = new Set([...assetIds, ...taskAssetIds]).size;
  const total = queriedTotal ?? uniqueTotal;
  const totalMockupDone = Math.min(total, taskMockupDone + mockupDone);
  const totalTitleDone = Math.min(total, taskTitleDone + titleDone);
  return {
    total,
    mockupDone: totalMockupDone,
    mockupImages,
    titleDone: totalTitleDone,
    titlePending: Math.max(0, total - totalTitleDone),
    batchCount: batchIds.size,
    shopCount: shopIds.size,
  };
}

function buildAutoListingTaskCenterSummary(summary: CloudListingReconciliationSummary | null): AutoListingTaskCenterSummary | null {
  if (!summary) {
    return null;
  }
  const preparing = summary.mockupRunningCount + summary.titleRunningCount;
  const submitting = summary.listingRunningCount;
  const waiting = Math.max(0, summary.processingCount - preparing - submitting);
  return {
    total: summary.total,
    waiting,
    preparing,
    submitting,
    completed: summary.completedCount,
    failed: summary.failedCount,
    dateLabel: summary.dateFrom === summary.dateTo ? summary.dateFrom : `${summary.dateFrom} - ${summary.dateTo}`,
  };
}

function buildAutoListingTaskCenterTasks(
  summary: CloudListingReconciliationSummary | null,
  legacyBatch: CloudListingBatch | null,
): AutoListingTaskCenterTask[] {
  const tasks = summary?.batches.map((batch) => buildTaskCenterTaskFromSummaryBatch(batch)) ?? [];
  if (legacyBatch) {
    tasks.unshift(buildTaskCenterTaskFromLegacyBatch(legacyBatch));
  }
  return tasks;
}

function buildTaskCenterTaskFromSummaryBatch(batch: CloudListingBatchProgressSummary): AutoListingTaskCenterTask {
  return {
    id: batch.batchId,
    label: batch.mockupTemplateName || `批次 ${batch.batchId.slice(0, 8)}`,
    stage: taskCenterStageFromBatchSummary(batch),
    totalCount: batch.total,
    completedCount: batch.completedCount,
    failedCount: batch.failedCount,
    shopAllocations: batch.shopCount > 0 ? [{ externalShopId: batch.batchId, shopName: "店铺分配", count: batch.shopCount }] : [],
    assignments: [],
    quotaError: batch.status === "failed" ? "批次执行失败，请检查云端任务日志" : null,
  };
}

function buildTaskCenterTaskFromLegacyBatch(batch: CloudListingBatch): AutoListingTaskCenterTask {
  const assignmentCounts = new Map<string, { shopName: string; count: number }>();
  for (const imageSet of batch.imageSets) {
    const current = assignmentCounts.get(imageSet.externalShopId) ?? { shopName: imageSet.shopName || imageSet.externalShopId, count: 0 };
    current.count += 1;
    assignmentCounts.set(imageSet.externalShopId, current);
  }
  return {
    id: `legacy-${batch.id}`,
    label: batch.mockupTemplateName || "历史批次",
    stage: taskCenterStageFromLegacyBatch(batch),
    totalCount: batch.imageSets.length,
    completedCount: batch.status === "uploaded" ? batch.imageSets.length : 0,
    failedCount: batch.status === "failed" ? batch.imageSets.length : 0,
    shopAllocations: [...assignmentCounts.entries()].map(([externalShopId, value]) => ({
      externalShopId,
      shopName: value.shopName,
      count: value.count,
    })),
    assignments: batch.imageSets.map((imageSet) => ({
      id: imageSet.sourceAssetId,
      sourceAssetId: imageSet.sourceAssetId,
      sourceSku: imageSet.sourceSku,
      shopName: imageSet.shopName,
      externalShopId: imageSet.externalShopId,
      status: batch.status === "uploaded" ? "completed" : batch.status === "failed" ? "failed" : "reserved",
      batchId: batch.id,
      canRelease: false,
    })),
    legacyLabel: "手动批次",
  };
}

function taskCenterStageFromBatchSummary(batch: CloudListingBatchProgressSummary): AutoListingTaskCenterTask["stage"] {
  if (batch.status === "failed") {
    return "failed";
  }
  if (batch.status === "uploaded") {
    return "completed";
  }
  if (batch.processingCount > 0) {
    return "preparing";
  }
  return "waiting";
}

function taskCenterStageFromLegacyBatch(batch: CloudListingBatch): AutoListingTaskCenterTask["stage"] {
  if (batch.status === "failed") {
    return "failed";
  }
  if (batch.status === "uploaded") {
    return "completed";
  }
  return "waiting";
}

function preparationMockupDone(task: LocalPreparationTask, visibleAssetIds: Set<string> = new Set()) {
  const progress = task.progress;
  const total = progress?.total ?? task.assetIds.length;
  const remainingAssetCount = task.assetIds.filter((assetId) => !visibleAssetIds.has(assetId)).length;
  if (!progress) {
    return 0;
  }
  if (progress.stage === "mockup") {
    return Math.min(progress.done, remainingAssetCount);
  }
  if (["title", "batch", "submit"].includes(progress.stage) || task.status === "prepared") {
    return Math.min(total, remainingAssetCount);
  }
  if (progress.stage === "failed") {
    return Math.min(Math.max(0, total - progress.failed), remainingAssetCount);
  }
  return 0;
}

function preparationTitleDone(task: LocalPreparationTask, visibleTitleAssetIds: Set<string> = new Set()) {
  const progress = task.progress;
  const total = progress?.total ?? task.assetIds.length;
  const remainingAssetIds = task.assetIds.filter((assetId) => !visibleTitleAssetIds.has(assetId));
  const draftDone = remainingAssetIds.filter((assetId) => task.context.draftsByAssetId[assetId]?.title?.trim()).length;
  if (draftDone > 0) {
    return draftDone;
  }
  if (!progress) {
    return 0;
  }
  if (progress.stage === "title") {
    return Math.min(progress.done, remainingAssetIds.length);
  }
  if (["batch", "submit"].includes(progress.stage) || task.status === "prepared") {
    return Math.min(total, remainingAssetIds.length);
  }
  if (progress.stage === "failed") {
    return Math.min(Math.max(0, total - progress.failed), remainingAssetIds.length);
  }
  return 0;
}

function readExternalShopId(shop: CloudShop) {
  return shop.externalShopId || shop.external_shop_id || shop.id;
}

function isSupportedImageFile(file: File) {
  const fileName = file.name.toLowerCase();
  return supportedImageTypes.has(file.type) || supportedImageExtensions.some((extension) => fileName.endsWith(extension));
}

function chunkFiles(files: File[], size: number) {
  const chunks: File[][] = [];
  for (let index = 0; index < files.length; index += size) {
    chunks.push(files.slice(index, index + size));
  }
  return chunks;
}

function chunkUploadFiles(files: File[], maxCount: number, maxBytes: number) {
  const chunks: File[][] = [];
  let current: File[] = [];
  let currentBytes = 0;
  for (const file of files) {
    const size = fileSize(file);
    if (current.length > 0 && (current.length >= maxCount || currentBytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(file);
    currentBytes += size;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

async function uploadAssetsWithFallback(
  uploadAssets: (files: File[]) => Promise<BatchUploadAssetsResult>,
  files: File[],
): Promise<BatchUploadAssetsResult> {
  try {
    return await uploadAssetsWithRetry(uploadAssets, files);
  } catch (error) {
    if (shouldStopUploadTask(error)) {
      throw error;
    }
    if (files.length <= 1) {
      return createUploadFailureResult(files, error);
    }
    const middle = Math.ceil(files.length / 2);
    const first = await uploadAssetsWithFallback(uploadAssets, files.slice(0, middle));
    const second = await uploadAssetsWithFallback(uploadAssets, files.slice(middle));
    return mergeUploadResults(first, second);
  }
}

async function uploadAssetsWithRetry(
  uploadAssets: (files: File[]) => Promise<BatchUploadAssetsResult>,
  files: File[],
) {
  for (let attempt = 0; attempt <= uploadRetryDelays.length; attempt += 1) {
    try {
      return await uploadAssets(files);
    } catch (error) {
      if (!isRetryableUploadError(error) || attempt >= uploadRetryDelays.length) {
        throw error;
      }
      await delay(uploadRetryDelays[attempt]);
    }
  }
  return createUploadFailureResult(files, new Error("上传请求未返回结"));
}

function shouldStopUploadTask(error: unknown) {
  return error instanceof CloudApiError && [401, 403, 404].includes(error.status);
}

function isRetryableUploadError(error: unknown) {
  if (error instanceof CloudApiError) {
    return [408, 429, 500, 502, 503, 504].includes(error.status);
  }
  const message = uploadErrorMessage(error).toLowerCase();
  return message.includes("timeout")
    || message.includes("timed out")
    || message.includes("failed to fetch")
    || message.includes("networkerror")
    || message.includes("504")
    || message.includes("超时")
    || message.includes("网关");
}

function createUploadFailureResult(files: File[], error: unknown): BatchUploadAssetsResult {
  return {
    ok: false,
    uploaded: 0,
    failed: files.length,
    assets: [],
    errors: files.map((file) => ({
      filename: fileDisplayName(file),
      message: uploadErrorMessage(error),
    })),
  };
}

function mergeUploadResults(
  first: BatchUploadAssetsResult,
  second: BatchUploadAssetsResult,
): BatchUploadAssetsResult {
  return {
    ok: first.ok && second.ok,
    uploaded: first.uploaded + second.uploaded,
    failed: first.failed + second.failed,
    assets: [...first.assets, ...second.assets],
    errors: [...first.errors, ...second.errors],
  };
}

function uploadErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createUploadPlan(files: File[]) {
  const batches = chunkUploadFiles(files, maxUploadBatchSize, maxUploadBatchBytes);
  const batchBytes = batches.map((batch) => batch.reduce((sum, file) => sum + fileSize(file), 0));
  const totalBytes = batchBytes.reduce((sum, size) => sum + size, 0);
  return {
    batches,
    batchBytes,
    totalBatches: batches.length,
    totalBytes,
    largestBatchBytes: batchBytes.length > 0 ? Math.max(...batchBytes) : 0,
  };
}

function createUploadTaskSnapshot(
  files: File[],
  source: UploadSource,
  plan: ReturnType<typeof createUploadPlan>,
  status: UploadTaskStatus,
  message: string,
): UploadTaskSnapshot {
  const now = new Date().toISOString();
  return {
    id: randomId(),
    source,
    status,
    totalFiles: files.length,
    totalBatches: plan.totalBatches,
    totalBytes: plan.totalBytes,
    uploaded: 0,
    failed: 0,
    processed: 0,
    currentBatch: 0,
    sampleFilenames: files.slice(0, 20).map(fileDisplayName),
    errors: [],
    message,
    updatedAt: now,
  };
}

function readUploadTaskSnapshot(): UploadTaskSnapshot | null {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(uploadTaskStorageKey);
    if (!raw) return null;
    return normalizeUploadTaskSnapshot(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeUploadTaskSnapshot(task: UploadTaskSnapshot | null) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    if (!task) {
      window.localStorage.removeItem(uploadTaskStorageKey);
      return;
    }
    window.localStorage.setItem(uploadTaskStorageKey, JSON.stringify(task));
  } catch {
    // 上传状态只是用户可见性增强，写入失败不能阻断真实上传
  }
}

function readUploadTaskHistory(): UploadTaskSnapshot[] {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(uploadTaskHistoryStorageKey);
    if (!raw) return [];
    const items = JSON.parse(raw);
    return Array.isArray(items)
      ? items.map(normalizeUploadTaskSnapshot).filter((item): item is UploadTaskSnapshot => Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function pushUploadTaskHistory(task: UploadTaskSnapshot) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const next = [task, ...readUploadTaskHistory().filter((item) => item.id !== task.id)].slice(0, 20);
    window.localStorage.setItem(uploadTaskHistoryStorageKey, JSON.stringify(next));
  } catch {
    // 忽略本地历史写入失败，避免影响上传主流程
  }
}

function normalizeUploadTaskSnapshot(value: unknown): UploadTaskSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const totalFiles = numberValue(value.totalFiles) ?? 0;
  const totalBatches = numberValue(value.totalBatches) ?? 0;
  const status = typeof value.status === "string" && ["selected", "running", "succeeded", "partial", "failed"].includes(value.status)
    ? value.status as UploadTaskStatus
    : "selected";
  return {
    id: typeof value.id === "string" && value.id.trim() ? value.id : randomId(),
    source: value.source === "folder" ? "folder" : "files",
    status,
    totalFiles,
    totalBatches,
    totalBytes: numberValue(value.totalBytes) ?? 0,
    uploaded: numberValue(value.uploaded) ?? 0,
    failed: numberValue(value.failed) ?? 0,
    processed: numberValue(value.processed) ?? 0,
    currentBatch: numberValue(value.currentBatch) ?? 0,
    currentBatchFiles: numberValue(value.currentBatchFiles),
    currentBatchBytes: numberValue(value.currentBatchBytes),
    sampleFilenames: Array.isArray(value.sampleFilenames) ? value.sampleFilenames.filter((item): item is string => typeof item === "string").slice(0, 20) : [],
    errors: normalizeUploadErrors(value.errors).slice(-20),
    message: typeof value.message === "string" ? value.message : undefined,
    startedAt: typeof value.startedAt === "string" ? value.startedAt : undefined,
    finishedAt: typeof value.finishedAt === "string" ? value.finishedAt : undefined,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date().toISOString(),
  };
}

function uploadTaskStatusText(status: UploadTaskStatus) {
  if (status === "running") return "上传";
  if (status === "succeeded") return "已完";
  if (status === "partial") return "部分完成";
  if (status === "failed") return "上传失败";
  return "已选择";
}

function isFreshRunningUploadTask(task: UploadTaskSnapshot | null) {
  if (task?.status !== "running") return false;
  const updatedAt = new Date(task.updatedAt).getTime();
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < 10 * 60 * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function randomId() {
  return globalThis.crypto?.randomUUID?.() ?? `upload-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function dedupeAssetsById(items: CloudAsset[]) {
  const byId = new Map<string, CloudAsset>();
  for (const item of items) {
    byId.set(item.id, item);
  }
  return [...byId.values()];
}

function mergeCloudAndLocalProcessingAssets(cloudAssets: CloudAsset[], localAssets: CloudAsset[]) {
  const byId = new Map<string, CloudAsset>();
  for (const asset of localAssets) {
    byId.set(asset.id, asset);
  }
  for (const asset of cloudAssets) {
    const existing = byId.get(asset.id);
    if (existing?.listingStatus && !asset.listingStatus) {
      byId.set(asset.id, { ...asset, listingStatus: existing.listingStatus });
    } else {
      byId.set(asset.id, asset);
    }
  }
  return [...byId.values()];
}

function filterLocalProcessingAssets(
  assets: CloudAsset[],
  filters: { productImageRuleId?: string; keyword?: string; externalShopId?: string },
) {
  const keyword = filters.keyword?.trim().toLowerCase() ?? "";
  return assets
    .filter((asset) => {
      if (filters.productImageRuleId && asset.productImageRuleId !== filters.productImageRuleId) {
        return false;
      }
      if (keyword) {
        const sku = asset.sku.toLowerCase();
        const filename = asset.sourceFilename.toLowerCase();
        if (!sku.includes(keyword) && !filename.includes(keyword)) {
          return false;
        }
      }
      if (filters.externalShopId && !asset.listingStatus?.shops?.some((shop) => shop.externalShopId === filters.externalShopId)) {
        return false;
      }
      return true;
    })
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime());
}

function readStoredLocalProcessingAssets(cloudApiBaseUrl?: string) {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(localProcessingStorageKey(cloudApiBaseUrl));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as StoredLocalProcessingAsset[];
    const now = Date.now();
    return parsed
      .filter((item) => item?.asset?.id && now - Number(item.savedAt ?? 0) < localProcessingRetentionMs)
      .map((item) => item.asset);
  } catch {
    return [];
  }
}

function writeStoredLocalProcessingAssets(cloudApiBaseUrl: string | undefined, assets: CloudAsset[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const key = localProcessingStorageKey(cloudApiBaseUrl);
    if (assets.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    const savedAt = Date.now();
    const existingSavedAtById = new Map<string, number>();
    const raw = window.localStorage.getItem(key);
    if (raw) {
      const existing = JSON.parse(raw) as StoredLocalProcessingAsset[];
      for (const item of existing) {
        if (item?.asset?.id && Number.isFinite(Number(item.savedAt))) {
          existingSavedAtById.set(item.asset.id, Number(item.savedAt));
        }
      }
    }
    const payload: StoredLocalProcessingAsset[] = dedupeAssetsById(assets)
      .filter((asset) => asset.id && asset.sku)
      .map((asset) => ({ asset, savedAt: existingSavedAtById.get(asset.id) ?? savedAt }))
      .filter((item) => savedAt - item.savedAt < localProcessingRetentionMs);
    if (payload.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(payload));
  } catch {
    // Local persistence is only a UI recovery aid; cloud batch records remain authoritative.
  }
}

function localProcessingStorageKey(cloudApiBaseUrl?: string) {
  const accountId = cloudAccountId();
  return `${localProcessingStoragePrefix}${cloudApiBaseUrl || "default"}${accountId ? `:${accountId}` : ""}`;
}

function readStoredLocalPreparationTasks(cloudApiBaseUrl?: string) {
  if (typeof window === "undefined") {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(localPreparationTaskStorageKey(cloudApiBaseUrl));
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as LocalPreparationTask[];
    const now = Date.now();
    return parsed.filter((task) => (
      task?.id
      && Array.isArray(task.assetIds)
      && task.context?.mockupTemplateId
      && now - Number(task.updatedAt ?? task.createdAt ?? 0) < localPreparationTaskRetentionMs
    ));
  } catch {
    return [];
  }
}

function writeStoredLocalPreparationTasks(cloudApiBaseUrl: string | undefined, tasks: LocalPreparationTask[]) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const key = localPreparationTaskStorageKey(cloudApiBaseUrl);
    const activeTasks = tasks.filter((task) => task.status !== "prepared");
    if (activeTasks.length === 0) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(activeTasks));
  } catch {
    // This cache only helps the UI resume local preparation; cloud listing batches remain authoritative.
  }
}

function localPreparationTaskStorageKey(cloudApiBaseUrl?: string) {
  const accountId = cloudAccountId();
  return `${localPreparationTaskStoragePrefix}${cloudApiBaseUrl || "default"}${accountId ? `:${accountId}` : ""}`;
}

function attachListingStatusFromBatch(asset: CloudAsset, batch: CloudListingBatch): CloudAsset {
  const imageSets = batch.imageSets.filter((item) => item.sourceAssetId === asset.id);
  if (imageSets.length === 0) {
    return asset;
  }
  const primary = imageSets[0];
  return {
    ...asset,
    generatedTitle: primary.title ?? asset.generatedTitle,
    listingStatus: {
      batchId: batch.id,
      status: batch.status,
      title: primary.title ?? asset.listingStatus?.title ?? null,
      uploadedAt: null,
      stage: primary.stage ?? asset.listingStatus?.stage ?? "ready",
      progress: primary.progress ?? asset.listingStatus?.progress ?? 35,
      stageMessage: primary.stageMessage ?? asset.listingStatus?.stageMessage ?? "已进入上传中，等待本地助手提",
      stageProgress: primary.stageProgress ?? asset.listingStatus?.stageProgress ?? null,
      productId: primary.productId ?? asset.listingStatus?.productId ?? null,
      completedAt: primary.completedAt ?? asset.listingStatus?.completedAt ?? null,
      shops: imageSets.map((imageSet) => {
        const shop = batch.shopTargets.find((target) => target.externalShopId === imageSet.externalShopId);
        return {
          externalShopId: imageSet.externalShopId,
          shopName: imageSet.shopName || shop?.shopName || imageSet.externalShopId,
          productTemplateName: imageSet.productTemplateName || shop?.productTemplateName || "",
          status: shop?.status ?? batch.status,
          stage: imageSet.stage ?? primary.stage ?? null,
          progress: imageSet.progress ?? primary.progress,
          stageMessage: imageSet.stageMessage ?? primary.stageMessage ?? null,
        };
      }),
    },
  };
}

function collectProcessingListingBatchIds(assets: CloudAsset[]) {
  const batchIds = new Set<string>();
  for (const asset of assets) {
    const status = asset.listingStatus;
    if (status?.batchId && status.status !== "uploaded") {
      batchIds.add(status.batchId);
    }
  }
  return [...batchIds];
}

function chunkItems<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += Math.max(1, size)) {
    chunks.push(items.slice(index, index + Math.max(1, size)));
  }
  return chunks;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex], currentIndex);
    }
  }));
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function resolveLocalMockupConcurrency() {
  if (typeof navigator === "undefined") {
    return 2;
  }
  const cores = Number(navigator.hardwareConcurrency || 0);
  if (!Number.isFinite(cores) || cores <= 0) {
    return 2;
  }
  if (cores >= 12) {
    return 4;
  }
  if (cores >= 8) {
    return 3;
  }
  return 2;
}

function normalizeActionOptions(value: unknown): ActionOption[] {
  return findArrayValue(value, ["actions", "items", "result"]).map((item) => {
    const record = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    return {
      id: Number(record.id ?? record.action_id ?? 0),
      title: String(record.title ?? record.name ?? record.action_name ?? "未命名活"),
      status: typeof record.status === "string" ? record.status : typeof record.state === "string" ? record.state : undefined,
    };
  }).filter((item) => item.id > 0);
}

function formatTitleGenerationError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.replace(/^Error:\s*/i, "").trim();
  const lower = message.toLowerCase();
  if (
    lower.includes("ai_title_image_timeout")
    || lower.includes("unable to download content")
    || lower.includes("provided url")
    || lower.includes("publicly accessible")
    || lower.includes("标题生成超时")
    || lower.includes("标题参考图下载超时")
  ) {
    return "标题生成超时：AI 暂时无法读取图片，系统已尝试压缩图片兜底。请稍后重试该商品";
  }
  if (lower.includes("request_timeout") || lower.includes("云服务响应超")) {
    return "标题生成请求超时：当前排队或 AI 响应较慢，请稍后重试";
  }
  return message.length > 180 ? `${message.slice(0, 180)}...` : message;
}

function formatLocalMockupError(error: unknown) {
  const rawMessage = error instanceof Error ? error.message : String(error);
  const message = rawMessage.replace(/^Error:\s*/i, "").trim();
  if (!message) return "本机渲染不可";
  if (message.includes("图片加载失败")) {
    return "本机无法读取源图或样机资";
  }
  if (message.toLowerCase().includes("tainted") || message.toLowerCase().includes("cors")) {
    return "浏览器跨域限制导致本机无法导出图";
  }
  return message.length > 120 ? `${message.slice(0, 120)}...` : message;
}

function findArrayValue(value: unknown, keys: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of keys) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  if (record.result && typeof record.result === "object") {
    const nested = record.result as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(nested[key])) return nested[key] as unknown[];
    }
  }
  return [];
}

function fileSize(file: File) {
  return Math.max(0, file.size || 0);
}

function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb >= 10 ? 0 : 1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb >= 10 ? 0 : 1)} MB`;
}

function fileDisplayName(file: File) {
  return file.webkitRelativePath || file.name;
}

function normalizeUploadErrors(value: unknown): UploadError[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    if (typeof item === "object" && item !== null) {
      const record = item as Record<string, unknown>;
      return {
        filename: typeof record.filename === "string" ? record.filename : "未知文件",
        message: typeof record.message === "string" ? record.message : "上传失败",
      };
    }
    return { filename: "未知文件", message: String(item) };
  });
}

function mergeMockupResults(existing: CloudMockupAsset[] | undefined, generated: CloudMockupAsset[]) {
  const resultByScene = new Map<string, CloudMockupAsset>();
  for (const item of existing ?? []) {
    resultByScene.set(mockupResultKey(item), item);
  }
  for (const item of generated) {
    resultByScene.set(mockupResultKey(item), item);
  }
  return [...resultByScene.values()];
}

function mockupResultKey(item: CloudMockupAsset) {
  return `${item.templateId}:${item.sceneIndex}`;
}

function hasMockupResults(asset: CloudAsset, templateId?: string) {
  return mockupResultsForDisplay(asset, templateId).length > 0;
}

function mockupActionText(asset: CloudAsset, renderingAssetId: string, templateId: string, templates: CloudMockupTemplate[]) {
  if (renderingAssetId === asset.id) return "生成";
  const template = templates.find((option) => option.id === templateId);
  const templateLabel = template?.name ?? "样机";
  return hasMockupResults(asset, templateId) ? `重新生成${templateLabel}` : `生成${templateLabel}`;
}

function mockupTemplateLabel(template: CloudMockupTemplate) {
  return `${template.name}（${template.sceneCount}张）`;
}

function mockupResultsForDisplay(asset: CloudAsset, templateId?: string): CloudMockupAsset[] {
  return [...(asset.mockupResults ?? [])]
    .filter((item) => !templateId || item.templateId === templateId)
    .sort((left, right) => {
    if (left.templateId !== right.templateId) {
      return left.templateId.localeCompare(right.templateId);
    }
    return left.sceneIndex - right.sceneIndex;
  });
}

function ratioLabel(value: string) {
  if (value === "portrait") return "3:4";
  if (value === "square") return "1:1";
  if (value === "landscape") return "4:3";
  if (value === "wide") return "16:9";
  return value;
}

function productImageRuleLabel(rule: CloudProductImageRule) {
  return `${rule.productType} · ${rule.aspectRatio}`;
}

function assetProductRuleLabel(asset: CloudAsset) {
  if (asset.productType && asset.aspectRatio) {
    return `${asset.productType} · ${asset.aspectRatio}`;
  }
  return ratioLabel(asset.ratioFamily);
}

function ratioFamilyForAspectRatio(aspectRatio: string) {
  const [width = 1, height = 1] = aspectRatio.split(":").map((value) => Number(value));
  const ratio = width / height;
  if (Math.abs(ratio - 1) < 0.01) return "square";
  if (Math.abs(ratio - 16 / 9) < 0.01) return "wide";
  if (ratio > 1) return "landscape";
  return "portrait";
}

function findProductRuleIdByRatioFamily(rules: CloudProductImageRule[], ratioFamily: string) {
  return rules.find((rule) => ratioFamilyForAspectRatio(rule.aspectRatio) === ratioFamily)?.id;
}

function resolveProductImageRuleForAsset(
  asset: CloudAsset,
  ruleById: Map<string, CloudProductImageRule>,
  rules: CloudProductImageRule[],
) {
  const storedRule = asset.productImageRuleId ? ruleById.get(asset.productImageRuleId) : undefined;
  if (storedRule) {
    return storedRule;
  }
  if (asset.productType && asset.aspectRatio) {
    const exactRule = rules.find((rule) => rule.productType === asset.productType && rule.aspectRatio === asset.aspectRatio);
    if (exactRule) {
      return exactRule;
    }
  }
  if (asset.aspectRatio) {
    const matchingRatioRule = rules.find((rule) => rule.aspectRatio === asset.aspectRatio);
    if (matchingRatioRule) {
      return matchingRatioRule;
    }
  }
  return rules.find((rule) => ratioFamilyForAspectRatio(rule.aspectRatio) === asset.ratioFamily);
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN");
}

function formatSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function normalizePositiveInt(value: string | number, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function featuredText(asset: CloudAsset) {
  const orders = asset.orderCount ?? 0;
  const users = asset.distinctUserCount ?? 0;
  const shops = asset.distinctShopCount ?? 0;
  if (orders === 0) return "已入精品";
  return `出单 ${orders} · ${users} 用户 · ${shops} 店铺`;
}

function cloneShopListingConfigForShop(config: ShopListingConfig, externalShopId: string, shopName: string): ShopListingConfig {
  return {
    ...config,
    externalShopId,
    newTemplateName: config.newTemplateName || config.productTemplateName || `${shopName}商品模板`,
  };
}

function buildListingConfigSnapshot(
  config: ShopListingConfig,
  options: {
    shopName: string;
    localShop?: Shop;
    localTemplate?: TemplateSummary;
  },
): CloudListingConfigSnapshot {
  return {
    externalShopId: config.externalShopId,
    shopName: options.shopName,
    localShopId: options.localShop?.id ?? config.externalShopId,
    localTemplateId: config.localTemplateId || undefined,
    localTemplateName: options.localTemplate?.name,
    productTemplateId: config.productTemplateId || undefined,
    productTemplateName: config.productTemplateName || config.newTemplateName || undefined,
    templateProduct: options.localTemplate?.payload,
    templateVideoLinks: [],
    uploadTemplateVideo: false,
    autoGenerateBarcode: config.autoGenerateBarcode,
    autoUpdateStock: config.autoUpdateStock,
    autoAddToAction: config.autoAddToAction,
    autoWarehouseId: typeof config.autoWarehouseId === "number" ? config.autoWarehouseId : undefined,
    autoStock: config.autoStock,
    autoActionId: typeof config.autoActionId === "number" ? config.autoActionId : undefined,
    autoActionPrice: config.autoActionPrice || undefined,
    autoActionStock: config.autoActionStock,
    postListingDelayMinutes: 0,
    actionDelayMinutes: 0,
    actionRetryCount: 1,
    actionRetryIntervalMinutes: 10,
    dailyListingLimit: config.dailyListingLimit,
  };
}

function shopListingConfigToPreference(config: ShopListingConfig): CloudListingPreferenceShopConfig {
  return {
    externalShopId: config.externalShopId,
    productTemplateId: config.productTemplateId,
    productTemplateName: config.productTemplateName,
    newTemplateName: config.newTemplateName,
    categoryLabel: config.categoryLabel,
    productTemplateShared: config.productTemplateShared,
    localTemplateId: config.localTemplateId,
    autoGenerateBarcode: config.autoGenerateBarcode,
    autoUpdateStock: config.autoUpdateStock,
    autoAddToAction: config.autoAddToAction,
    autoWarehouseId: config.autoWarehouseId,
    autoStock: config.autoStock,
    autoActionId: config.autoActionId,
    autoActionPrice: config.autoActionPrice,
    autoActionStock: config.autoActionStock,
    actionDelayMinutes: config.actionDelayMinutes,
    actionRetryCount: config.actionRetryCount,
    actionRetryIntervalMinutes: config.actionRetryIntervalMinutes,
    dailyListingLimit: config.dailyListingLimit,
  };
}

function createDefaultListingDraft(externalShopId: string): ListingAssetDraft {
  return {
    externalShopId,
    imageAssetIds: [],
    title: "",
    titleStatus: "idle",
  };
}

function createListingDraftFromAsset(asset: CloudAsset, externalShopId: string): ListingAssetDraft {
  const title = asset.generatedTitle?.trim() || "";
  return {
    ...createDefaultListingDraft(externalShopId),
    title,
    titleStatus: title ? "done" : "idle",
  };
}

function syncGeneratedTitlesToDrafts(current: Record<string, ListingAssetDraft>, assets: CloudAsset[]) {
  let changed = false;
  const next = { ...current };
  for (const asset of assets) {
    const title = asset.generatedTitle?.trim();
    if (!title) {
      continue;
    }
    const existing = next[asset.id];
    if (!existing) {
      next[asset.id] = {
        ...createDefaultListingDraft(""),
        title,
        titleStatus: "done",
      };
      changed = true;
      continue;
    }
    if (!existing.title.trim() && existing.titleStatus !== "generating") {
      next[asset.id] = {
        ...existing,
        title,
        titleStatus: "done",
        titleError: undefined,
      };
      changed = true;
    }
  }
  return changed ? next : current;
}

function assetDisplayTitle(asset: CloudAsset, draft?: ListingAssetDraft) {
  return draft?.title?.trim() || asset.generatedTitle?.trim() || asset.listingStatus?.title?.trim() || "";
}

function listingOverallProgress(asset: CloudAsset, mockupDone: number, mockupTotal: number, titleDone: boolean) {
  const statusProgress = asset.listingStatus?.progress;
  if (typeof statusProgress === "number") {
    return Math.max(0, Math.min(100, Math.round(statusProgress)));
  }
  const mockupScore = mockupTotal > 0 ? Math.min(20, Math.round((mockupDone / mockupTotal) * 20)) : 0;
  const titleScore = titleDone ? 15 : 0;
  const uploadedScore = asset.listingStatus?.status === "uploaded" ? 65 : 0;
  return Math.max(0, Math.min(100, mockupScore + titleScore + uploadedScore));
}

function progressPercent(done: number, total: number) {
  if (total <= 0) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function summarizePreparationErrors(errors: string[]) {
  const unique = [...new Set(errors.map((error) => error.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return "";
  }
  const summary = unique.slice(0, 3).join("");
  return unique.length > 3 ? `${summary}；还${unique.length - 3} 个错误` : summary;
}

function buildPreparationStageProgress(
  task: LocalPreparationTask | undefined,
  mockupDone: number,
  mockupTotal: number,
  titleDone: boolean,
): CloudListingStageProgress | null {
  if (!task) {
    return null;
  }
  const progress = task.progress;
  const stage = progress?.stage ?? "queued";
  const total = progress?.total ?? task.assetIds.length;
  const done = progress?.done ?? 0;
  const failed = progress?.failed ?? 0;
  const message = task.error || progress?.message;
  const order: LocalPreparationStage[] = ["queued", "mockup", "title", "batch", "submit"];
  const state = (key: LocalPreparationStage): "queued" | "running" | "done" | "failed" => {
    if (task.status === "failed" || stage === "failed") return key === "batch" ? "failed" : order.indexOf(key) < order.indexOf("batch") ? "done" : "queued";
    if (stage === key) return "running";
    return order.indexOf(stage) > order.indexOf(key) ? "done" : "queued";
  };
  return {
    mockup: {
      status: state("mockup"),
      progress: progressPercent(mockupDone, mockupTotal),
      done: mockupDone,
      total: mockupTotal,
      message: stage === "mockup" && mockupDone === 0 ? message : undefined,
      updatedAt: progress?.updatedAt ? new Date(progress.updatedAt).toISOString() : undefined,
    },
    title: {
      status: state("title"),
      progress: stage === "title" ? progress?.percent : titleDone ? 100 : 0,
      done: stage === "title" ? done : titleDone ? 1 : 0,
      total: stage === "title" ? total : 1,
      message: stage === "title" ? message : undefined,
      updatedAt: progress?.updatedAt ? new Date(progress.updatedAt).toISOString() : undefined,
    },
    listing: {
      status: stage === "batch" || stage === "submit" ? "running" : state("batch"),
      progress: stage === "batch" || stage === "submit" ? progress?.percent : undefined,
      done: stage === "batch" || stage === "submit" ? done : undefined,
      total: stage === "batch" || stage === "submit" ? total : undefined,
      message: stage === "batch" || stage === "submit" ? message : undefined,
      updatedAt: progress?.updatedAt ? new Date(progress.updatedAt).toISOString() : undefined,
    },
  };
}

function listingPreparationOverallProgress(task: LocalPreparationTask | undefined, fallback: number) {
  if (!task?.progress) {
    return fallback;
  }
  const stagePercent = Math.max(0, Math.min(100, Math.round(task.progress.percent ?? 0)));
  const baseByStage: Record<LocalPreparationStage, number> = {
    queued: 0,
    mockup: 0,
    title: 20,
    batch: 35,
    submit: 45,
    failed: fallback,
  };
  const spanByStage: Record<LocalPreparationStage, number> = {
    queued: 5,
    mockup: 20,
    title: 15,
    batch: 10,
    submit: 5,
    failed: 0,
  };
  const stage = task.progress.stage;
  return Math.max(
    0,
    Math.min(100, Math.round((baseByStage[stage] ?? 0) + ((spanByStage[stage] ?? 0) * stagePercent) / 100)),
  );
}

function repairJobPhase(job: JobSummary): RepairImageProgress["phase"] {
  if (job.status === "succeeded") return "succeeded";
  if (job.status === "failed") return "failed";
  if (job.status === "cancelled") return "cancelled";
  return "running";
}

function repairJobMessage(job: JobSummary) {
  if (job.status === "succeeded") return "历史商品图片修复已完";
  if (job.status === "failed") return job.lastError || job.error || "历史商品图片修复失败";
  if (job.status === "cancelled") return "历史商品图片修复已取";
  return "历史商品图片修复执行";
}

function repairProgressPercent(progress: RepairImageProgress) {
  if (progress.job) {
    return Math.max(0, Math.min(100, Math.round(progress.job.progress)));
  }
  if (progress.phase === "succeeded") return 100;
  if (progress.phase === "failed" || progress.phase === "cancelled") return 100;
  if (typeof progress.scanned === "number" && typeof progress.total === "number" && progress.total > 0) {
    return Math.max(5, Math.min(95, Math.round((progress.scanned / progress.total) * 100)));
  }
  return progress.phase === "scanning" ? 8 : 5;
}

function listingStageRows(
  progress: CloudListingStageProgress | null | undefined,
  fallback: {
    mockupDone: number;
    mockupTotal: number;
    titleDone: boolean;
    listingDone: boolean;
    currentStage?: string | null;
  },
) {
  const rows = [
    { key: "mockup", label: "套图", fallbackText: fallback.mockupDone >= fallback.mockupTotal ? "已完成" : `${fallback.mockupDone}/${fallback.mockupTotal}` },
    { key: "title", label: "标题", fallbackText: fallback.titleDone ? "已完成" : fallback.currentStage === "title" ? "生成中" : "未生成" },
    { key: "listing", label: "上架包", fallbackText: fallback.listingDone ? "已完成" : fallback.currentStage === "listing" ? "生成中" : "未生成" },
  ];
  return rows.map((row) => {
    const state = progress?.[row.key];
    return {
      ...row,
      text: state ? listingStageStateText(state.status, state.progress, state.message) : row.fallbackText,
    };
  });
}

function listingStageStateText(status?: string, progress?: number, message?: string) {
  if (message) {
    const mapped = listingStageMessage(message);
    if (mapped !== message) return mapped;
  }
  const pct = typeof progress === "number" && progress > 0 && progress < 100 ? ` ${Math.round(progress)}%` : "";
  if (status === "done") return "已完";
  if (status === "queued") return "排队";
  if (status === "running") return `进行${pct}`;
  if (status === "waiting") return message ? "等待处理" : "等待";
  if (status === "failed") return "失败";
  if (status === "skipped") return "跳过";
  return "排队";
}

function listingStageLabel(stage?: string | null) {
  if (stage === "mockup") return "套图";
  if (stage === "title") return "标题";
  if (stage === "listing") return "上架";
  if (stage === "stock") return "库存";
  if (stage === "barcode") return "条码";
  if (stage === "action") return "活动";
  if (stage === "workflow") return "流程";
  if (stage === "ready") return "待上";
  return "进度";
}

function listingStageMessage(message?: string | null) {
  if (!message) return "";
  const map: Record<string, string> = {
    queued: "排队",
    ready: "等待上传",
    running: "进行",
    submitting: "提交Ozon ",
    uploaded: "上架已提",
    completed: "流程完成",
    waiting_post_process: "等待 3 分钟后更新库存和条码",
    waiting_action: "等待商品可参加活",
    action_candidate_pending: "暂未进入活动候选，10 分钟后重",
  };
  return map[message] ?? message;
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  return [item, ...items.filter((current) => current.id !== item.id)];
}

function trimText(value: string | undefined | null, maxLength: number) {
  return (value ?? "").trim().slice(0, maxLength);
}

function optionalTrimText(value: string | undefined | null, maxLength: number) {
  const text = trimText(value, maxLength);
  return text || undefined;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function isMockupTemplateId(value: string) {
  return /^[a-z0-9][a-z0-9_-]{1,79}$/.test(value.trim());
}

function localDateString(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}

function mapDailyListingStatsByShop(stats: ShopDailyListingStat[], date: string) {
  const mapped = new Map<string, ShopDailyListingStat>();
  for (const stat of stats) {
    if (stat.date === date) {
      mapped.set(stat.externalShopId, stat);
    }
  }
  return mapped;
}

function countListingAssignments(
  assets: CloudAsset[],
  drafts: Record<string, ListingAssetDraft>,
  configs: ShopListingConfig[],
) {
  const counts = new Map<string, number>();
  if (configs.length === 0) {
    return counts;
  }
  const activeShopIds = new Set(configs.map((config) => config.externalShopId));
  assets.forEach((asset, index) => {
    const fallbackShopId = configs[index % configs.length].externalShopId;
    const draftShopId = drafts[asset.id]?.externalShopId;
    const externalShopId = draftShopId && activeShopIds.has(draftShopId) ? draftShopId : fallbackShopId;
    counts.set(externalShopId, (counts.get(externalShopId) ?? 0) + 1);
  });
  return counts;
}

function buildListingQuotaSnapshots(
  configs: ShopListingConfig[],
  statsByShopId: Map<string, ShopDailyListingStat>,
  selectedCountsByShopId: Map<string, number>,
): ListingQuotaSnapshot[] {
  return configs.map((config) => {
    const stat = statsByShopId.get(config.externalShopId);
    const listedCount = safeCount(stat?.listedCount);
    const reservedCount = Math.max(listedCount, safeCount(stat?.reservedCount));
    const pendingCount = safeCount(stat?.pendingCount);
    const selectedCount = selectedCountsByShopId.get(config.externalShopId) ?? 0;
    const remaining = Math.max(0, config.dailyListingLimit - reservedCount);
    return {
      externalShopId: config.externalShopId,
      limit: config.dailyListingLimit,
      listedCount,
      reservedCount,
      pendingCount,
      selectedCount,
      remaining,
      overBy: Math.max(0, selectedCount - remaining),
    };
  });
}

function buildListingQuotaWarnings(
  quotas: ListingQuotaSnapshot[],
  shopNameById: Map<string, string>,
) {
  return quotas
    .filter((quota) => quota.overBy > 0)
    .map((quota) => {
      const shopName = shopNameById.get(quota.externalShopId) ?? quota.externalShopId;
      return `${shopName}\uff1a\u9650\u989d ${quota.limit}\uff0c\u5df2\u4e0a\u67b6 ${quota.listedCount}\uff0c\u5904\u7406\u4e2d ${quota.pendingCount}\uff0c\u5df2\u5360\u7528 ${quota.reservedCount}\uff0c\u5269\u4f59 ${quota.remaining}\uff0c\u672c\u6b21\u9009\u62e9 ${quota.selectedCount}`;
    });
}

function safeCount(value: unknown) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function buildOneClickListingDisabledReason(input: Parameters<typeof getAutoListingDisabledReason>[0]) {
  return getAutoListingDisabledReason(input);
}

function serializeListingPreferences(preferences: CloudListingPreferences) {
  return JSON.stringify(preferences);
}

function listingStatusText(asset: CloudAsset) {
  const status = asset.listingStatus;
  if (!status) return "";
  const shopText = status.shops.map((shop) => shop.shopName).filter(Boolean).join("\u3001") || "\u5e97\u94fa";
  const titleText = status.title ? ` · ${status.title}` : "";
  return `${status.status === "uploaded" ? "\u5df2\u4e0a\u4f20" : "\u4e0a\u4f20\u4e2d"}\uff1a${shopText}${titleText}`;
}
