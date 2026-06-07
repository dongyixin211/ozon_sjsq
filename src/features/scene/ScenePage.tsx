import { useState } from "react";
import { api } from "../../lib/api";
import { PathInput } from "../../lib/PathInput";

interface Props {
  onJobStarted: () => void;
}

export function ScenePage({ onJobStarted }: Props) {
  const [sourceRoot, setSourceRoot] = useState("");
  const [outputRoot, setOutputRoot] = useState("");
  const [mockupRoot, setMockupRoot] = useState("");
  const [singleImage, setSingleImage] = useState("");
  const [aspectRatio, setAspectRatio] = useState("1:1");
  const [sizeLabel, setSizeLabel] = useState("");
  const [maxItems, setMaxItems] = useState(0);
  const [sceneIds, setSceneIds] = useState<string[]>(["flat_full"]);

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

  const startLocal = async () => {
    await api.startLocalSceneJob({
      sourceRoot,
      outputRoot,
      mockupRoot,
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
