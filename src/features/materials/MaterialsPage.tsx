import { useState } from "react";
import type { AppSettings, PreflightIssue } from "@shared/types";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";
import { hasBlockingIssues, PreflightPanel } from "../../lib/PreflightPanel";

interface Props {
  settings: AppSettings;
  onJobStarted: () => void;
  onNavigate: (page: "settings") => void;
}

export function MaterialsPage({ settings, onJobStarted, onNavigate }: Props) {
  const [sourceRoot, setSourceRoot] = useState(settings.defaultSourceRoot);
  const [outputRoot, setOutputRoot] = useState(settings.defaultOutputRoot);
  const [contentRoot, setContentRoot] = useState(settings.contentRoot);
  const [watermarkPath, setWatermarkPath] = useState(settings.watermarkPath);
  const [maxItems, setMaxItems] = useState(0);
  const [convertOriginals, setConvertOriginals] = useState(settings.convertOriginals);
  const [generateAiImages, setGenerateAiImages] = useState(false);
  const [generateCopy, setGenerateCopy] = useState(settings.generateCopy);
  const [prompt, setPrompt] = useState(
    settings.imagePromptTemplate || "你是一名 Ozon 俄罗斯电商视觉设计师，保持产品主体一致，生成干净专业的 3:4 商品图。",
  );
  const [titlePrompt, setTitlePrompt] = useState(
    settings.titlePromptTemplate || "请根据商品信息生成适合 Ozon 的中文商品标题。货号：{sku}；图片：{image_names}。",
  );
  const [descriptionPrompt, setDescriptionPrompt] = useState(
    settings.descriptionPromptTemplate || "请生成适合 Ozon 的中文简介和 5 条卖点，返回 JSON：title、description、bullets。货号：{sku}；图片：{image_names}。",
  );
  const [issues, setIssues] = useState<PreflightIssue[]>([]);
  const [checking, setChecking] = useState(false);

  const request = () => ({
      sourceRoot,
      portraitRoot: outputRoot,
      contentRoot,
      watermarkPath,
      imageBaseUrl: settings.imageBaseUrl,
      textBaseUrl: settings.textBaseUrl,
      imageProvider: settings.imageProvider,
      textProvider: settings.textProvider,
      imageModel: settings.imageModel,
      textModel: settings.textModel,
      imagePromptTemplate: prompt,
      titlePromptTemplate: titlePrompt,
      descriptionPromptTemplate: descriptionPrompt,
      generateAiImages,
      convertOriginals,
      generateCopy,
      exportExcel: settings.exportExcel,
      maxItems: maxItems || undefined,
  });

  const preflight = async () => {
    setChecking(true);
    try {
      const data = await api.preflightMaterials(request());
      setIssues(data);
      return data;
    } finally {
      setChecking(false);
    }
  };

  const start = async () => {
    const data = await preflight();
    if (hasBlockingIssues(data)) return;
    await api.startMaterialsJob(request());
    onJobStarted();
  };

  return (
    <div className="content-grid">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>AI 商品素材</h2>
            <p className="muted">按 SKU 文件夹批量生成竖版图、3:4 图、标题、简介、卖点和 Excel 汇总。</p>
          </div>
          <div className="toolbar">
            <button className="secondary-button" onClick={preflight} disabled={checking}>{checking ? "检查中" : "预检查"}</button>
            <button className="primary-button" onClick={start}>开始处理</button>
          </div>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>源目录</label>
            <PathInput value={sourceRoot} onChange={setSourceRoot} placeholder="选择源图目录" />
          </div>
          <div className="field">
            <label>输出目录</label>
            <PathInput value={outputRoot} onChange={setOutputRoot} placeholder="选择输出目录" />
          </div>
          <div className="field">
            <label>文案输出目录</label>
            <PathInput value={contentRoot} onChange={setContentRoot} placeholder="选择文案输出目录" />
          </div>
          <div className="field">
            <label>水印图片</label>
            <PathInput value={watermarkPath} onChange={setWatermarkPath} mode="file" placeholder="选择水印图片" />
          </div>
          <div className="field">
            <label>图片接口</label>
            <input value={settings.imageBaseUrl} readOnly />
          </div>
          <div className="field">
            <label>文案接口</label>
            <input value={settings.textBaseUrl} readOnly />
          </div>
          <div className="field">
            <label>图片模型</label>
            <input value={settings.imageModel} readOnly />
          </div>
          <div className="field">
            <label>文案模型</label>
            <input value={settings.textModel} readOnly />
          </div>
          <div className="field">
            <label>数量上限 (0=不限)</label>
            <input type="number" min={0} value={maxItems} onChange={(event) => setMaxItems(Number(event.target.value))} />
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>开始前预检查</h2>
        </div>
        <PreflightPanel issues={issues} onAction={() => onNavigate("settings")} />
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>处理选项</h2>
        </div>
        <div className="form-grid">
          <div className="field">
            <label>
              <input type="checkbox" checked={convertOriginals} onChange={(event) => setConvertOriginals(event.target.checked)} />
              {" "}转换原图 (3:4 + 水印)
            </label>
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={generateAiImages} onChange={(event) => setGenerateAiImages(event.target.checked)} />
              {" "}生成 AI 商品图
            </label>
          </div>
          <div className="field">
            <label>
              <input type="checkbox" checked={generateCopy} onChange={(event) => setGenerateCopy(event.target.checked)} />
              {" "}生成标题/简介/卖点
            </label>
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>AI 提示词 (Prompt)</h2>
        <div className="form-grid">
          <div className="field">
            <label>生图 Prompt</label>
            <textarea rows={4} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
          </div>
          <div className="field">
            <label>标题 Prompt</label>
            <textarea rows={4} value={titlePrompt} onChange={(event) => setTitlePrompt(event.target.value)} />
          </div>
          <div className="field">
            <label>简介/卖点 Prompt</label>
            <textarea rows={4} value={descriptionPrompt} onChange={(event) => setDescriptionPrompt(event.target.value)} />
          </div>
        </div>
      </section>
    </div>
  );
}
