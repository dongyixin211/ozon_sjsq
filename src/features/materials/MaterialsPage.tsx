import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppSettings, MaterialsRequest, PreflightIssue } from "@shared/types";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";
import { hasBlockingIssues, PreflightPanel } from "../../lib/PreflightPanel";

const XIAOQIAN_BASE_URL = "https://xiaoqian.art/v1";
const PIXEL_BASE_URL = "https://ai-pixel.online/v1";
const DEFAULT_TITLE_PROMPT = "请根据商品信息生成适合 Ozon 的中文商品标题，只返回标题。货号：{sku}；图片：{image_names}。";
const MATERIAL_FORM_CACHE_KEY = "ozon-sjsq.materials-form.v1";

type MaterialAction = "portrait" | "title";

interface Props {
  settings: AppSettings;
  onChanged: () => void;
  onJobStarted: () => void;
  onNavigate: (page: "settings") => void;
}

interface MaterialFormDraft {
  portraitSourceRoot: string;
  portraitOutputRoot: string;
  watermarkPath: string;
  portraitMaxItems: number;
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
  return provider.trim().toLowerCase() === "pixel";
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

export function MaterialsPage({ settings, onChanged, onJobStarted, onNavigate }: Props) {
  const [initialForm] = useState(() => readMaterialForm(settings));
  const settingsRef = useRef(settings);
  const onChangedRef = useRef(onChanged);
  const saveMaterialSettingsRef = useRef<() => Promise<AppSettings>>(async () => settings);
  const didMountRef = useRef(false);
  const [portraitSourceRoot, setPortraitSourceRoot] = useState(initialForm.portraitSourceRoot);
  const [portraitOutputRoot, setPortraitOutputRoot] = useState(initialForm.portraitOutputRoot);
  const [watermarkPath, setWatermarkPath] = useState(initialForm.watermarkPath);
  const [portraitMaxItems, setPortraitMaxItems] = useState(initialForm.portraitMaxItems);
  const [titleSourceRoot, setTitleSourceRoot] = useState(initialForm.titleSourceRoot);
  const [titleOutputRoot, setTitleOutputRoot] = useState(initialForm.titleOutputRoot);
  const [titleMaxItems, setTitleMaxItems] = useState(initialForm.titleMaxItems);
  const [titleModel, setTitleModel] = useState(initialForm.titleModel);
  const [titleModels, setTitleModels] = useState<string[]>([]);
  const [loadingTitleModels, setLoadingTitleModels] = useState(false);
  const [titleModelError, setTitleModelError] = useState("");
  const [titleApiKey, setTitleApiKey] = useState("");
  const [savingTitleApiKey, setSavingTitleApiKey] = useState(false);
  const [titleKeyMessage, setTitleKeyMessage] = useState("");
  const [titleKeyError, setTitleKeyError] = useState("");
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
      textModel: titleModel || settingsRef.current.textModel,
      titlePromptTemplate: titlePrompt,
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
    titleModel,
    titlePrompt,
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

  const saveTitleApiKey = async () => {
    const apiKey = titleApiKey.trim();
    setTitleKeyMessage("");
    setTitleKeyError("");
    if (isOllamaProvider(settingsRef.current.textProvider)) {
      setTitleKeyMessage("本地 Ollama 无需 API Key。");
      return;
    }
    if (!apiKey) {
      setTitleKeyError("请先填写 API Key");
      return;
    }
    setSavingTitleApiKey(true);
    try {
      await api.saveProviderSecrets(settingsRef.current, {
        textApiKey: apiKey,
      });
      await saveMaterialSettings();
      setTitleApiKey("");
      setTitleKeyMessage("当前文案 Provider 的 API Key 已保存。");
      await loadTitleModels();
    } catch (error) {
      setTitleKeyError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingTitleApiKey(false);
    }
  };

  const materialRequest = (action: MaterialAction): MaterialsRequest => {
    const isPortrait = action === "portrait";
    const currentSettings = settingsRef.current;
    return {
      sourceRoot: isPortrait ? portraitSourceRoot : titleSourceRoot,
      portraitRoot: isPortrait ? portraitOutputRoot : "",
      contentRoot: isPortrait ? undefined : titleOutputRoot,
      watermarkPath: isPortrait ? watermarkPath : undefined,
      imageBaseUrl: currentSettings.imageBaseUrl,
      textBaseUrl: currentSettings.textBaseUrl,
      imageProvider: currentSettings.imageProvider,
      textProvider: currentSettings.textProvider,
      imageModel: currentSettings.imageModel,
      textModel: titleModel || currentSettings.textModel,
      imagePromptTemplate: "",
      titlePromptTemplate: titlePrompt,
      descriptionPromptTemplate: "",
      generateAiImages: false,
      convertOriginals: isPortrait,
      generateCopy: !isPortrait,
      exportExcel: false,
      maxItems: (isPortrait ? portraitMaxItems : titleMaxItems) || undefined,
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
  const titleProviderIsOllama = isOllamaProvider(settings.textProvider);
  const titleProviderIsPixel = isPixelProvider(settings.textProvider);
  const titleBaseUrl =
    settings.textBaseUrl
    || (titleProviderIsPixel ? PIXEL_BASE_URL : XIAOQIAN_BASE_URL);

  return (
    <div className="content-grid">
      <section className="panel half">
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
      </section>

      <section className="panel half">
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
            <input value={titleBaseUrl} readOnly />
          </div>
          <div className="field">
            <label>AI 模型</label>
            {titleModels.length > 0 ? (
              <select value={titleModel} onChange={(event) => setTitleModel(event.target.value)}>
                {!titleModels.includes(titleModel) && titleModel ? <option value={titleModel}>{titleModel}</option> : null}
                {titleModels.map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            ) : (
              <input value={titleModel} onChange={(event) => setTitleModel(event.target.value)} placeholder="填写模型名" />
            )}
          </div>
          <div className="field">
            <label>文案 API Key</label>
            <input
              type="password"
              value={titleApiKey}
              onChange={(event) => setTitleApiKey(event.target.value)}
              disabled={titleProviderIsOllama}
              placeholder={
                titleProviderIsOllama
                  ? "Ollama 无需 API Key"
                  : titleProviderIsPixel
                    ? "填写 Pixel API Key 并保存"
                    : "填写后保存，之后默认使用"
              }
            />
          </div>
          <div className="field">
            <label>数量上限 (0=不限)</label>
            <input type="number" min={0} value={titleMaxItems} onChange={(event) => setTitleMaxItems(Number(event.target.value))} />
          </div>
          <div className="field full">
            <label>标题 Prompt</label>
            <textarea rows={4} value={titlePrompt} onChange={(event) => setTitlePrompt(event.target.value)} />
          </div>
        </div>
        <div className="toolbar" style={{ marginTop: 8 }}>
          <button className="secondary-button" onClick={saveTitleApiKey} disabled={savingTitleApiKey}>
            {savingTitleApiKey ? "保存中" : "保存 API Key"}
          </button>
          <button className="secondary-button" onClick={loadTitleModels} disabled={loadingTitleModels}>
            {loadingTitleModels ? "加载中" : "刷新模型"}
          </button>
          {titleKeyMessage ? <span className="muted">{titleKeyMessage}</span> : null}
          {titleKeyError ? <span className="error-text">{titleKeyError}</span> : null}
          {titleModelError ? <span className="error-text">{titleModelError}</span> : null}
        </div>
      </section>

      <section className="panel half">
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
      </section>

      <section className="panel half">
        <div className="panel-header">
          <h2>预检查结果</h2>
        </div>
        <PreflightPanel issues={issues} onAction={() => onNavigate("settings")} />
      </section>
    </div>
  );
}
