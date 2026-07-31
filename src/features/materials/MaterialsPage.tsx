import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, MaterialsRequest, PreflightIssue } from "@shared/types";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";
import { hasBlockingIssues, PreflightPanel } from "../../lib/PreflightPanel";

const XIAOQIAN_BASE_URL = "https://xiaoqian.art/v1";
const PIXEL_IMAGE_MODEL = "gpt-image-2";
const DEFAULT_TITLE_PROMPT = "请根据商品信息生成适合 Ozon 的中文商品标题，只返回标题。货号：{sku}；图片：{image_names}。";
const DEFAULT_IMAGE_PROMPT = "请基于参考商品图生成一张适合 Ozon 商品主图的高质量 3:4 竖版商品图。保持商品主体、图案、颜色和材质一致，背景干净，真实摄影质感，不添加文字、水印、logo 或边框。货号：{sku}；参考图片：{image_names}。";
const MATERIAL_FORM_CACHE_KEY = "ozon-sjsq.materials-form.v1";

type MaterialAction = "portrait" | "aiImage" | "title";
type MaterialPageMode = MaterialAction | "rename";

interface Props {
  mode: MaterialPageMode;
  settings: AppSettings;
  onChanged: () => void;
  onJobStarted: () => void;
}

interface MaterialFormDraft {
  portraitSourceRoot: string;
  portraitOutputRoot: string;
  watermarkPath: string;
  portraitMaxItems: number;
  aiUploadRoot: string;
  aiImageModel: string;
  aiMaxItems: number;
  aiPrompt: string;
  titleSourceRoot: string;
  titleOutputRoot: string;
  titleMaxItems: number;
  titleModel: string;
  titlePrompt: string;
  renameSourceRoot: string;
  renameOutputRoot: string;
  renamePrefix: string;
}

function formFromSettings(settings: AppSettings): MaterialFormDraft {
  return {
    portraitSourceRoot: settings.materialPortraitSourceRoot || settings.defaultSourceRoot,
    portraitOutputRoot: settings.materialPortraitOutputRoot || settings.defaultOutputRoot,
    watermarkPath: settings.watermarkPath,
    portraitMaxItems: settings.materialPortraitMaxItems || 0,
    aiUploadRoot: settings.materialPortraitOutputRoot || settings.defaultOutputRoot,
    aiImageModel: settings.imageModel || PIXEL_IMAGE_MODEL,
    aiMaxItems: 0,
    aiPrompt: settings.imagePromptTemplate || DEFAULT_IMAGE_PROMPT,
    titleSourceRoot: settings.materialTitleSourceRoot || settings.defaultSourceRoot,
    titleOutputRoot: settings.materialTitleOutputRoot || settings.contentRoot,
    titleMaxItems: settings.materialTitleMaxItems || 0,
    titleModel: settings.textModel,
    titlePrompt: settings.titlePromptTemplate || DEFAULT_TITLE_PROMPT,
    renameSourceRoot: settings.materialRenameSourceRoot || settings.defaultSourceRoot,
    renameOutputRoot: settings.materialRenameOutputRoot || settings.defaultOutputRoot,
    renamePrefix: settings.materialRenamePrefix,
  };
}

function textValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function isOllamaProvider(provider: string) {
  return provider.trim().toLowerCase() === "ollama";
}

function isPixelProvider(provider: string) {
  return provider.trim().toLowerCase() === "pixel" || provider.trim().toLowerCase() === "cloud-proxy";
}

function readMaterialForm(settings: AppSettings): MaterialFormDraft {
  const fallback = formFromSettings(settings);
  if (typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(MATERIAL_FORM_CACHE_KEY);
    if (!raw) {
      return fallback;
    }
    const cached = JSON.parse(raw) as Partial<MaterialFormDraft>;
    return {
      portraitSourceRoot: textValue(cached.portraitSourceRoot, fallback.portraitSourceRoot),
      portraitOutputRoot: textValue(cached.portraitOutputRoot, fallback.portraitOutputRoot),
      watermarkPath: textValue(cached.watermarkPath, fallback.watermarkPath),
      portraitMaxItems: numberValue(cached.portraitMaxItems, fallback.portraitMaxItems),
      aiUploadRoot: textValue(cached.aiUploadRoot, fallback.aiUploadRoot),
      aiImageModel: textValue(cached.aiImageModel, fallback.aiImageModel),
      aiMaxItems: numberValue(cached.aiMaxItems, fallback.aiMaxItems),
      aiPrompt: textValue(cached.aiPrompt, fallback.aiPrompt),
      titleSourceRoot: textValue(cached.titleSourceRoot, fallback.titleSourceRoot),
      titleOutputRoot: textValue(cached.titleOutputRoot, fallback.titleOutputRoot),
      titleMaxItems: numberValue(cached.titleMaxItems, fallback.titleMaxItems),
      titleModel: textValue(cached.titleModel, fallback.titleModel),
      titlePrompt: textValue(cached.titlePrompt, fallback.titlePrompt),
      renameSourceRoot: textValue(cached.renameSourceRoot, fallback.renameSourceRoot),
      renameOutputRoot: textValue(cached.renameOutputRoot, fallback.renameOutputRoot),
      renamePrefix: textValue(cached.renamePrefix, fallback.renamePrefix),
    };
  } catch {
    return fallback;
  }
}

function writeMaterialForm(form: MaterialFormDraft) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(MATERIAL_FORM_CACHE_KEY, JSON.stringify(form));
  } catch {
    // localStorage can be unavailable in restricted webviews; database saving still runs.
  }
}

function chooseTitleModel(models: string[], current: string, fallback: string) {
  const cleanCurrent = current.trim();
  const cleanFallback = fallback.trim();
  const unsuitable = /(image|embedding|audio|tts|codex|review)/i;
  if (cleanCurrent && models.includes(cleanCurrent) && !unsuitable.test(cleanCurrent)) {
    return cleanCurrent;
  }
  if (cleanFallback && models.includes(cleanFallback) && !unsuitable.test(cleanFallback)) {
    return cleanFallback;
  }
  const preferred = models.find((model) => /gpt/i.test(model) && !unsuitable.test(model));
  if (preferred) {
    return preferred;
  }
  return models.find((model) => !unsuitable.test(model)) || cleanCurrent || cleanFallback || models[0] || "";
}

function chooseImageModel(models: string[], current: string) {
  const cleanCurrent = current.trim();
  if (cleanCurrent && models.includes(cleanCurrent)) {
    return cleanCurrent;
  }
  if (models.includes(PIXEL_IMAGE_MODEL)) {
    return PIXEL_IMAGE_MODEL;
  }
  const preferred = models.find((model) => /image|img/i.test(model));
  return preferred || cleanCurrent || PIXEL_IMAGE_MODEL;
}

export function MaterialsPage({ mode, settings, onChanged, onJobStarted }: Props) {
  const [initialForm] = useState(() => readMaterialForm(settings));
  const settingsRef = useRef(settings);
  const onChangedRef = useRef(onChanged);
  const saveMaterialSettingsRef = useRef<() => Promise<AppSettings>>(async () => settings);
  const didMountRef = useRef(false);
  const [portraitSourceRoot, setPortraitSourceRoot] = useState(initialForm.portraitSourceRoot);
  const [portraitOutputRoot, setPortraitOutputRoot] = useState(initialForm.portraitOutputRoot);
  const [watermarkPath, setWatermarkPath] = useState(initialForm.watermarkPath);
  const [portraitMaxItems, setPortraitMaxItems] = useState(initialForm.portraitMaxItems);
  const [aiUploadRoot, setAiUploadRoot] = useState(initialForm.aiUploadRoot);
  const [aiImageModel, setAiImageModel] = useState(initialForm.aiImageModel);
  const [imageModels, setImageModels] = useState<string[]>([]);
  const [loadingImageModels, setLoadingImageModels] = useState(false);
  const [imageModelError, setImageModelError] = useState("");
  const [aiMaxItems, setAiMaxItems] = useState(initialForm.aiMaxItems);
  const [aiPrompt, setAiPrompt] = useState(initialForm.aiPrompt);
  const [titleSourceRoot, setTitleSourceRoot] = useState(initialForm.titleSourceRoot);
  const [titleOutputRoot, setTitleOutputRoot] = useState(initialForm.titleOutputRoot);
  const [titleMaxItems, setTitleMaxItems] = useState(initialForm.titleMaxItems);
  const [titleModel, setTitleModel] = useState(initialForm.titleModel);
  const [titleModels, setTitleModels] = useState<string[]>([]);
  const [loadingTitleModels, setLoadingTitleModels] = useState(false);
  const [titleModelError, setTitleModelError] = useState("");
  const [titlePrompt, setTitlePrompt] = useState(initialForm.titlePrompt);
  const [renameSourceRoot, setRenameSourceRoot] = useState(initialForm.renameSourceRoot);
  const [renameOutputRoot, setRenameOutputRoot] = useState(initialForm.renameOutputRoot);
  const [renamePrefix, setRenamePrefix] = useState(initialForm.renamePrefix);
  const [renaming, setRenaming] = useState(false);
  const [renameMessage, setRenameMessage] = useState("");
  const [renameError, setRenameError] = useState("");
  const [issues, setIssues] = useState<PreflightIssue[]>([]);
  const [checkingAction, setCheckingAction] = useState<MaterialAction | null>(null);
  const materialForm = useMemo<MaterialFormDraft>(
    () => ({
      portraitSourceRoot,
      portraitOutputRoot,
      watermarkPath,
      portraitMaxItems,
      aiUploadRoot,
      aiImageModel,
      aiMaxItems,
      aiPrompt,
      titleSourceRoot,
      titleOutputRoot,
      titleMaxItems,
      titleModel,
      titlePrompt,
      renameSourceRoot,
      renameOutputRoot,
      renamePrefix,
    }),
    [
      portraitSourceRoot,
      portraitOutputRoot,
      watermarkPath,
      portraitMaxItems,
      aiUploadRoot,
      aiImageModel,
      aiMaxItems,
      aiPrompt,
      titleSourceRoot,
      titleOutputRoot,
      titleMaxItems,
      titleModel,
      titlePrompt,
      renameSourceRoot,
      renameOutputRoot,
      renamePrefix,
    ],
  );
  const materialFormRef = useRef(materialForm);
  materialFormRef.current = materialForm;

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);

  const saveMaterialSettings = useCallback(async () => {
    const nextSettings: AppSettings = {
      ...settingsRef.current,
      defaultSourceRoot: portraitSourceRoot || settingsRef.current.defaultSourceRoot,
      defaultOutputRoot: portraitOutputRoot || settingsRef.current.defaultOutputRoot,
      watermarkPath,
      contentRoot: titleOutputRoot,
      materialPortraitSourceRoot: portraitSourceRoot,
      materialPortraitOutputRoot: portraitOutputRoot,
      materialPortraitMaxItems: portraitMaxItems || 0,
      materialTitleSourceRoot: titleSourceRoot,
      materialTitleOutputRoot: titleOutputRoot,
      materialTitleMaxItems: titleMaxItems || 0,
      materialRenameSourceRoot: renameSourceRoot,
      materialRenameOutputRoot: renameOutputRoot,
      materialRenamePrefix: renamePrefix,
    };
    const saved = await api.saveSettings(nextSettings);
    settingsRef.current = saved;
    await onChangedRef.current();
    return saved;
  }, [
    portraitSourceRoot,
    portraitOutputRoot,
    watermarkPath,
    portraitMaxItems,
    titleSourceRoot,
    titleOutputRoot,
    titleMaxItems,
    renameSourceRoot,
    renameOutputRoot,
    renamePrefix,
  ]);

  const loadTitleModels = async () => {
    setLoadingTitleModels(true);
    setTitleModelError("");
    try {
      const currentSettings = settingsRef.current;
      const models = await api.listAiModels(
        currentSettings.textBaseUrl || XIAOQIAN_BASE_URL,
        currentSettings.textProvider || "xiaoqian",
        "text",
      );
      setTitleModels(models);
      setTitleModel((current) => {
        return chooseTitleModel(models, current, settingsRef.current.textModel);
      });
    } catch (error) {
      setTitleModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingTitleModels(false);
    }
  };

  const loadImageModels = async () => {
    setLoadingImageModels(true);
    setImageModelError("");
    try {
      const currentSettings = settingsRef.current;
      const models = await api.listAiModels(
        currentSettings.imageBaseUrl,
        currentSettings.imageProvider,
        "image",
      );
      setImageModels(models);
      setAiImageModel((current) => chooseImageModel(models, current));
    } catch (error) {
      setImageModelError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingImageModels(false);
    }
  };

  useEffect(() => {
    void loadTitleModels();
  }, [settings.textBaseUrl, settings.textProvider]);

  useEffect(() => {
    writeMaterialForm(materialForm);
  }, [materialForm]);

  useEffect(() => {
    saveMaterialSettingsRef.current = saveMaterialSettings;
  }, [saveMaterialSettings]);

  useEffect(() => {
    if (!didMountRef.current) {
      didMountRef.current = true;
      return undefined;
    }
    const timer = window.setTimeout(() => {
      saveMaterialSettings().catch((error) => console.error(error));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [saveMaterialSettings]);

  useEffect(() => {
    return () => {
      writeMaterialForm(materialFormRef.current);
      saveMaterialSettingsRef.current().catch((error) => console.error(error));
    };
  }, []);

  const materialRequest = (action: MaterialAction): MaterialsRequest => {
    const isPortrait = action === "portrait";
    const isAiImage = action === "aiImage";
    const isTitle = action === "title";
    const currentSettings = settingsRef.current;
    const uploadRoot = aiUploadRoot || portraitOutputRoot || currentSettings.defaultOutputRoot;
    return {
      sourceRoot: isPortrait ? portraitSourceRoot : isAiImage ? uploadRoot : titleSourceRoot,
      portraitRoot: isPortrait ? portraitOutputRoot : isAiImage ? uploadRoot : "",
      contentRoot: isTitle ? titleOutputRoot : undefined,
      watermarkPath: isPortrait ? watermarkPath : undefined,
      imageBaseUrl: currentSettings.imageBaseUrl,
      textBaseUrl: currentSettings.textBaseUrl,
      imageProvider: currentSettings.imageProvider,
      textProvider: currentSettings.textProvider,
      imageModel: currentSettings.imageModel || aiImageModel || PIXEL_IMAGE_MODEL,
      textModel: currentSettings.textModel || titleModel,
      imagePromptTemplate: isAiImage ? currentSettings.imagePromptTemplate || aiPrompt : "",
      titlePromptTemplate: currentSettings.titlePromptTemplate || titlePrompt,
      descriptionPromptTemplate: currentSettings.descriptionPromptTemplate,
      generateAiImages: isAiImage,
      convertOriginals: isPortrait,
      generateCopy: isTitle,
      exportExcel: false,
      maxItems: (isPortrait ? portraitMaxItems : isAiImage ? aiMaxItems : titleMaxItems) || undefined,
    };
  };

  const preflight = async (action: MaterialAction) => {
    setCheckingAction(action);
    try {
      await saveMaterialSettings();
      const data = await api.preflightMaterials(materialRequest(action));
      setIssues(data);
      return data;
    } finally {
      setCheckingAction(null);
    }
  };

  const start = async (action: MaterialAction) => {
    setCheckingAction(action);
    try {
      const request = materialRequest(action);
      await saveMaterialSettings();
      const data = await api.preflightMaterials(request);
      setIssues(data);
      if (hasBlockingIssues(data)) return;
      await api.startMaterialsJob(request);
      onJobStarted();
    } finally {
      setCheckingAction(null);
    }
  };

  const renameImages = async () => {
    setRenaming(true);
    setRenameMessage("");
    setRenameError("");
    try {
      await saveMaterialSettings();
      const result = await api.renameMaterialImages({
        sourceRoot: renameSourceRoot,
        outputRoot: renameOutputRoot,
        prefix: renamePrefix,
      });
      setRenameMessage(`已生成 ${result.count} 张重命名图片：${result.outputRoot}`);
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : String(error));
    } finally {
      setRenaming(false);
    }
  };

  const renameExample = `${renamePrefix.trim() || "前缀"}001.jpg`;
  const isBusy = checkingAction !== null;
  const titleProviderIsPixel = isPixelProvider(settings.textProvider);
  const titleBaseUrl =
    settings.textBaseUrl
    || (titleProviderIsPixel ? settings.textBaseUrl : XIAOQIAN_BASE_URL);
  const imageProviderLabel = settings.imageProvider === "cloud-proxy" ? "云端统一配置" : settings.imageBaseUrl;
  const textProviderLabel = settings.textProvider === "cloud-proxy" ? "云端统一配置" : titleBaseUrl;

  return (
    <div className="content-grid">
      {mode === "portrait" ? <section className="panel">
        <div className="panel-header">
          <div>
            <h2>转 3:4 + 水印</h2>
            <p className="muted">把原图批量转成 3:4 商品图，可叠加水印。</p>
          </div>
          <div className="toolbar">
            <button className="secondary-button" onClick={() => preflight("portrait")} disabled={isBusy}>
              {checkingAction === "portrait" ? "检查中" : "预检查"}
            </button>
            <button className="primary-button" onClick={() => start("portrait")} disabled={isBusy}>
              {checkingAction === "portrait" ? "处理中" : "开始转换"}
            </button>
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>源目录</label>
            <PathInput value={portraitSourceRoot} onChange={setPortraitSourceRoot} placeholder="选择源图目录" />
          </div>
          <div className="field">
            <label>输出目录</label>
            <PathInput value={portraitOutputRoot} onChange={setPortraitOutputRoot} placeholder="选择 3:4 输出目录" />
          </div>
          <div className="field">
            <label>水印图片</label>
            <PathInput value={watermarkPath} onChange={setWatermarkPath} mode="file" placeholder="选择水印图片" />
          </div>
          <div className="field">
            <label>数量上限 (0=不限)</label>
            <input type="number" min={0} value={portraitMaxItems} onChange={(event) => setPortraitMaxItems(Number(event.target.value))} />
          </div>
        </div>
      </section> : null}

      {mode === "aiImage" ? <section className="panel">
        <div className="panel-header">
          <div>
            <h2>GPT 图片生成</h2>
            <p className="muted">按上传图片目录中的 SKU 文件夹生成，每个文件夹只取第一张原图。</p>
          </div>
          <div className="toolbar">
            <button className="secondary-button" onClick={() => preflight("aiImage")} disabled={isBusy}>
              {checkingAction === "aiImage" ? "检查中" : "预检查"}
            </button>
            <button className="primary-button" onClick={() => start("aiImage")} disabled={isBusy}>
              {checkingAction === "aiImage" ? "处理中" : "开始生成"}
            </button>
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>上传图片目录</label>
            <PathInput value={aiUploadRoot} onChange={setAiUploadRoot} placeholder="选择上传图片目录" />
          </div>
          <div className="field">
            <label>AI 接口</label>
            <input value={imageProviderLabel} readOnly />
          </div>
          <div className="field">
            <label>AI 模型</label>
            <input value={settings.imageModel || aiImageModel || PIXEL_IMAGE_MODEL} readOnly />
          </div>
          <div className="field">
            <label>数量上限 (0=不限)</label>
            <input type="number" min={0} value={aiMaxItems} onChange={(event) => setAiMaxItems(Number(event.target.value))} />
          </div>
          <div className="field full">
            <label>图片 Prompt</label>
            <textarea rows={4} value={settings.imagePromptTemplate || aiPrompt} readOnly />
          </div>
        </div>
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button className="secondary-button" onClick={loadImageModels} disabled={loadingImageModels}>
            {loadingImageModels ? "加载中" : "刷新模型"}
          </button>
          {imageModelError ? <span className="error-text">{imageModelError}</span> : null}
          {imageModels.length > 0 ? <span className="muted">云端可用模型 {imageModels.length} 个</span> : null}
        </div>
      </section> : null}

      {mode === "title" ? <section className="panel">
        <div className="panel-header">
          <div>
            <h2>AI 生成标题</h2>
            <p className="muted">读取 SKU 图片信息，生成 Ozon 商品标题。</p>
          </div>
          <div className="toolbar">
            <button className="secondary-button" onClick={() => preflight("title")} disabled={isBusy}>
              {checkingAction === "title" ? "检查中" : "预检查"}
            </button>
            <button className="primary-button" onClick={() => start("title")} disabled={isBusy}>
              {checkingAction === "title" ? "处理中" : "开始生成"}
            </button>
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>源目录</label>
            <PathInput value={titleSourceRoot} onChange={setTitleSourceRoot} placeholder="选择源图目录" />
          </div>
          <div className="field">
            <label>标题输出目录</label>
            <PathInput value={titleOutputRoot} onChange={setTitleOutputRoot} placeholder="选择标题输出目录" />
          </div>
          <div className="field">
            <label>AI 接口</label>
            <input value={textProviderLabel} readOnly />
          </div>
          <div className="field">
            <label>AI 模型</label>
            <input value={settings.textModel || titleModel} readOnly />
          </div>
          <div className="field">
            <label>数量上限 (0=不限)</label>
            <input type="number" min={0} value={titleMaxItems} onChange={(event) => setTitleMaxItems(Number(event.target.value))} />
          </div>
          <div className="field full">
            <label>标题 Prompt</label>
            <textarea rows={4} value={settings.titlePromptTemplate || titlePrompt} readOnly />
          </div>
        </div>
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button className="secondary-button" onClick={loadTitleModels} disabled={loadingTitleModels}>
            {loadingTitleModels ? "加载中" : "刷新模型"}
          </button>
          {titleModelError ? <span className="error-text">{titleModelError}</span> : null}
          {titleModels.length > 0 ? <span className="muted">云端可用模型 {titleModels.length} 个</span> : null}
        </div>
      </section> : null}

      {mode === "rename" ? <section className="panel">
        <div className="panel-header">
          <div>
            <h2>图片重命名</h2>
            <p className="muted">按文件名排序复制图片，生成“前缀 + 001”这类序号文件名。</p>
          </div>
          <div className="toolbar">
            <button className="secondary-button" onClick={renameImages} disabled={renaming}>
              {renaming ? "处理中" : "开始重命名"}
            </button>
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>原素材文件夹</label>
            <PathInput value={renameSourceRoot} onChange={setRenameSourceRoot} placeholder="选择原素材文件夹" />
          </div>
          <div className="field">
            <label>生成后存放目录</label>
            <PathInput value={renameOutputRoot} onChange={setRenameOutputRoot} placeholder="选择存放目录" />
          </div>
          <div className="field">
            <label>前缀</label>
            <input value={renamePrefix} onChange={(event) => setRenamePrefix(event.target.value)} placeholder="例如 SKU-" />
          </div>
          <div className="field">
            <label>命名示例</label>
            <input value={renameExample} readOnly />
          </div>
        </div>
        {renameMessage && <p className="muted">{renameMessage}</p>}
        {renameError && <p className="error-text">{renameError}</p>}
      </section> : null}

      {mode !== "rename" ? <section className="panel">
        <div className="panel-header">
          <h2>预检查结果</h2>
        </div>
        <PreflightPanel issues={issues} />
      </section> : null}
    </div>
  );
}
