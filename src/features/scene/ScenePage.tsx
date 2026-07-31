import { useEffect, useState } from "react";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";

interface Props {
  onJobStarted: () => void;
}

const SCENE_FORM_CACHE_KEY = "ozon-sjsq:scene-form:v1";
const defaultSceneIds = ["flat_full"];

interface SceneFormDraft {
  sourceRoot: string;
  outputRoot: string;
  mockupRoot: string;
  singleImage: string;
  aspectRatio: string;
  sizeLabel: string;
  maxItems: number;
  sceneIds: string[];
}

function defaultSceneForm(): SceneFormDraft {
  return {
    sourceRoot: "",
    outputRoot: "",
    mockupRoot: "",
    singleImage: "",
    aspectRatio: "1:1",
    sizeLabel: "",
    maxItems: 0,
    sceneIds: defaultSceneIds,
  };
}

function readSceneForm() {
  const fallback = defaultSceneForm();
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(SCENE_FORM_CACHE_KEY);
    if (!raw) return fallback;
    const cached = JSON.parse(raw) as Partial<SceneFormDraft>;
    return {
      sourceRoot: textValue(cached.sourceRoot, fallback.sourceRoot),
      outputRoot: textValue(cached.outputRoot, fallback.outputRoot),
      mockupRoot: textValue(cached.mockupRoot, fallback.mockupRoot),
      singleImage: textValue(cached.singleImage, fallback.singleImage),
      aspectRatio: textValue(cached.aspectRatio, fallback.aspectRatio),
      sizeLabel: textValue(cached.sizeLabel, fallback.sizeLabel),
      maxItems: numberValue(cached.maxItems, fallback.maxItems),
      sceneIds: Array.isArray(cached.sceneIds) && cached.sceneIds.length > 0
        ? cached.sceneIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : fallback.sceneIds,
    };
  } catch {
    return fallback;
  }
}

function writeSceneForm(form: SceneFormDraft) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SCENE_FORM_CACHE_KEY, JSON.stringify(form));
  } catch {
    // localStorage can be unavailable in restricted webviews.
  }
}

function textValue(value: unknown, fallback: string) {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

export function ScenePage({ onJobStarted }: Props) {
  const [initialForm] = useState(readSceneForm);
  const [sourceRoot, setSourceRoot] = useState(initialForm.sourceRoot);
  const [outputRoot, setOutputRoot] = useState(initialForm.outputRoot);
  const [mockupRoot, setMockupRoot] = useState(initialForm.mockupRoot);
  const [singleImage, setSingleImage] = useState(initialForm.singleImage);
  const [aspectRatio, setAspectRatio] = useState(initialForm.aspectRatio);
  const [sizeLabel, setSizeLabel] = useState(initialForm.sizeLabel);
  const [maxItems, setMaxItems] = useState(initialForm.maxItems);
  const [sceneIds, setSceneIds] = useState<string[]>(initialForm.sceneIds);

  const availableScenes = [
    { id: "flat_full", label: "平铺全幅" },
    { id: "headscarf_side", label: "头巾侧戴" },
    { id: "headscarf_back", label: "头巾后戴" },
    { id: "bow_and_fold", label: "折叠系结" },
    { id: "size_chart", label: "尺码图" },
  ];

  const toggleScene = (id: string) => {
    setSceneIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  };

  useEffect(() => {
    writeSceneForm({
      sourceRoot,
      outputRoot,
      mockupRoot,
      singleImage,
      aspectRatio,
      sizeLabel,
      maxItems,
      sceneIds,
    });
  }, [sourceRoot, outputRoot, mockupRoot, singleImage, aspectRatio, sizeLabel, maxItems, sceneIds]);

  const startLocal = async () => {
    await api.startLocalSceneJob({
      sourceRoot,
      outputRoot,
      mockupRoot,
      singleImage: singleImage.trim() || undefined,
      aspectRatio,
      sceneIds,
      sizeLabel,
      maxItems: maxItems || undefined,
    });
    onJobStarted();
  };

  return (
    <div className="content-grid">
      <section className="panel">
        <div className="panel-header">
          <div>
            <h2>本地场景图合成</h2>
            <p className="muted">基于模板布局，将商品原图合成为电商场景展示图。</p>
          </div>
          <button className="primary-button" onClick={startLocal}>开始生成</button>
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
            <label>模板目录</label>
            <PathInput value={mockupRoot} onChange={setMockupRoot} placeholder="选择 mockups 目录" />
          </div>
          <div className="field">
            <label>单张图片</label>
            <PathInput value={singleImage} onChange={setSingleImage} mode="file" placeholder="或选择单张图片" />
          </div>
          <div className="field">
            <label>比例</label>
            <select value={aspectRatio} onChange={(e) => setAspectRatio(e.target.value)}>
              <option value="1:1">1:1 (正方形)</option>
              <option value="3:4">3:4 (竖版)</option>
              <option value="4:3">4:3 (横版)</option>
              <option value="16:9">16:9 (宽屏)</option>
            </select>
          </div>
          <div className="field">
            <label>尺寸标注</label>
            <input value={sizeLabel} onChange={(e) => setSizeLabel(e.target.value)} placeholder='例如 35.83 x 35.83 inches (91 x 91 cm)' />
          </div>
          <div className="field">
            <label>数量上限 (0=不限)</label>
            <input type="number" min={0} value={maxItems} onChange={(e) => setMaxItems(Number(e.target.value))} />
          </div>
        </div>
      </section>

      <section className="panel">
        <h2>场景模板</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {availableScenes.map((scene) => (
            <label key={scene.id} style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={sceneIds.includes(scene.id)}
                onChange={() => toggleScene(scene.id)}
              />
              {scene.label}
            </label>
          ))}
        </div>
      </section>
    </div>
  );
}
