import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene7-layer-stack"));
const templateRoot = path.join(outputDir, "templates");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT = templateRoot;

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(templateRoot, { recursive: true });

const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const baseTemplate = JSON.parse(await fs.readFile(path.join(baseDir, "template.json"), "utf8"));
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?scene7LayerStack=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);

const candidates = [
  {
    name: "baseline",
    mutate: () => {},
  },
  {
    name: "add-cutout-under-red-mask",
    mutate: (template) => addScene7Cutout(template, { order: 0.5 }),
  },
  {
    name: "add-cutout-under-alpha-mask",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      addScene7Cutout(template, { order: 0.5 });
    },
  },
  {
    name: "ps-stack-alpha-mask",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      addScene7Cutout(template, { order: 0.5 });
      setScene7LayerOrder(template, {
        "桌布链接图 拷贝 18": 1,
        "图层 11": 2,
        "桌布链接图 拷贝 7": 3,
      });
    },
  },
  {
    name: "cutout-above-lower-alpha",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      addScene7Cutout(template, { order: 1.5 });
    },
  },
  {
    name: "cutout-above-all-alpha",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      addScene7Cutout(template, { order: 3.5 });
    },
  },
  {
    name: "hide-vase-layer-alpha",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      addScene7Cutout(template, { order: 0.5 });
      removeScene7Layer(template, "图层 11");
    },
  },
  {
    name: "vase-above-all-alpha",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      addScene7Cutout(template, { order: 0.5 });
      setScene7LayerOrder(template, { "图层 11": 3.6 });
    },
  },
  {
    name: "swap-replace-alpha",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      addScene7Cutout(template, { order: 0.5 });
      setScene7LayerOrder(template, {
        "桌布链接图 拷贝 18": 3,
        "桌布链接图 拷贝 7": 1,
      });
    },
  },
  {
    name: "cutout-mask-only-alpha",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      addScene7Cutout(template, { order: 3.5, mode: "object-mask" });
    },
  },
  {
    name: "remove-layer-11",
    mutate: (template) => {
      removeScene7Layer(template, "图层 11");
    },
  },
  {
    name: "remove-layer-11-alpha",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      removeScene7Layer(template, "图层 11");
    },
  },
  {
    name: "plain-transform",
    mutate: (template) => {
      deleteScene7Meshes(template);
    },
  },
  {
    name: "plain-transform-alpha",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      deleteScene7Meshes(template);
    },
  },
  {
    name: "plain-transform-one-layer",
    mutate: (template) => {
      deleteScene7Meshes(template);
      keepScene7ReplaceLayer(template, "桌布链接图 拷贝 7");
    },
  },
  {
    name: "plain-transform-one-layer-alpha",
    copyMode: "scene7-alpha-masks",
    mutate: (template) => {
      deleteScene7Meshes(template);
      keepScene7ReplaceLayer(template, "桌布链接图 拷贝 7");
    },
  },
];

const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  if (candidate.copyMode === "scene7-alpha-masks") {
    await convertScene7MasksToAlpha(targetDir);
  }
  const template = structuredClone(baseTemplate);
  candidate.mutate(template);
  normalizeScene7Orders(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rendered = await renderMockupsWithTemplate({ templateDir: candidate.name, sourceBuffer, sku, sceneIndexes: [7] });
  const metrics = [];
  for (const scene of rendered.scenes) {
    const sceneId = String(scene.index).padStart(2, "0");
    await fs.writeFile(path.join(outputDir, `${candidate.name}-cloud-${sceneId}.png`), scene.buffer);
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${sceneId}.gif`));
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    metrics.push({
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
  }
  const summary = {
    name: candidate.name,
    average: Number(average(metrics.map((item) => item.similarity)).toFixed(2)),
    firstEight: Number(average(metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    scene7: metrics.find((item) => item.scene === 7)?.similarity,
    metrics,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.average,
    firstEight: summary.firstEight,
    scene7: summary.scene7,
  }));
}

summaries.sort((left, right) => (right.scene7 ?? 0) - (left.scene7 ?? 0));
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
await createSceneComparison(sharp, summaries, referenceDir, outputDir, sku, 7);

console.table(summaries.map((item) => ({
  name: item.name,
  average: item.average,
  firstEight: item.firstEight,
  scene7: item.scene7,
})));
console.log(path.join(outputDir, "summary.json"));
console.log(path.join(outputDir, "scene-07-compare.jpg"));

function addScene7Cutout(template, options = {}) {
  const scene = scene7(template);
  if (scene.layers.some((layer) => layer.file === "layers/scene-07-layer-004.png")) {
    return;
  }
  const layer = {
    order: options.order ?? 0.5,
    name: options.mode === "object-mask" ? "scene 7 object cutout mask" : "ChatGPT Image 2026年6月8日 13_34_04 (7)-抠图",
    left: 0,
    top: 0,
    width: 800,
    height: 1067,
    opacity: 1,
    kind: "image",
    blendMode: "normal",
    file: options.mode === "object-mask" ? "layers/scene-07-layer-004-objects.png" : "layers/scene-07-layer-004.png",
  };
  scene.layers.push(layer);
}

function setScene7LayerOrder(template, orderMap) {
  for (const layer of scene7(template).layers) {
    if (Object.prototype.hasOwnProperty.call(orderMap, layer.name)) {
      layer.order = orderMap[layer.name];
    }
  }
}

function removeScene7Layer(template, name) {
  const scene = scene7(template);
  scene.layers = scene.layers.filter((layer) => layer.name !== name);
}

function deleteScene7Meshes(template) {
  for (const layer of scene7(template).layers) {
    if (layer.kind === "replace") {
      delete layer.perspectiveMesh;
    }
  }
}

function keepScene7ReplaceLayer(template, name) {
  const scene = scene7(template);
  scene.layers = scene.layers.filter((layer) => layer.kind !== "replace" || layer.name === name);
}

function normalizeScene7Orders(template) {
  const scene = scene7(template);
  scene.layers.sort((left, right) => left.order - right.order);
  for (let index = 0; index < scene.layers.length; index += 1) {
    scene.layers[index].order = index;
  }
}

function scene7(template) {
  const scene = template.scenes.find((item) => item.index === 7);
  if (!scene) {
    throw new Error("scene 7 not found");
  }
  return scene;
}

async function convertScene7MasksToAlpha(targetDir) {
  await convertOneMaskToAlpha(targetDir, "masks/scene-07-replace-001.png");
  await convertOneMaskToAlpha(targetDir, "masks/scene-07-replace-003.png");
  await createObjectCutoutLayer(targetDir);
}

async function convertOneMaskToAlpha(targetDir, relativePath) {
  const inputPath = path.join(targetDir, relativePath);
  await sharp(inputPath)
    .ensureAlpha()
    .extractChannel("alpha")
    .png()
    .toFile(`${inputPath}.tmp.png`);
  await fs.rename(`${inputPath}.tmp.png`, inputPath);
}

async function createObjectCutoutLayer(targetDir) {
  const layerPath = path.join(targetDir, "layers", "scene-07-layer-004.png");
  const outputPath = path.join(targetDir, "layers", "scene-07-layer-004-objects.png");
  const { data, info } = await sharp(layerPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  for (let offset = 0; offset < output.length; offset += 4) {
    const r = data[offset];
    const g = data[offset + 1];
    const b = data[offset + 2];
    const a = data[offset + 3];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const isBrightTable = a > 0 && r > 205 && g > 195 && b > 175 && max - min < 45;
    if (isBrightTable) {
      output[offset + 3] = 0;
    }
  }
  await sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  }).png().toFile(outputPath);
}

async function calculateMae(sharp, referenceBuffer, cloudBuffer) {
  const reference = await rawRgb(sharp, referenceBuffer);
  const cloud = await rawRgb(sharp, cloudBuffer);
  let sum = 0;
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    sum += (
      Math.abs(reference.data[offset] - cloud.data[offset])
      + Math.abs(reference.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(reference.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
  }
  return sum / (reference.data.length / 3);
}

async function rawRgb(sharp, buffer) {
  return sharp(buffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function createSceneComparison(sharp, summaries, referenceDir, outputDir, sku, sceneIndex) {
  const sceneId = String(sceneIndex).padStart(2, "0");
  const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${sceneId}.gif`));
  const panels = [await labelPanel(sharp, referenceBuffer, `PS scene ${sceneIndex}`)];
  for (const summary of summaries) {
    const buffer = await fs.readFile(path.join(outputDir, `${summary.name}-cloud-${sceneId}.png`));
    panels.push(await labelPanel(sharp, buffer, `${summary.name} ${summary.scene7}%`));
  }
  await sharp({
    create: {
      width: panels.length * 300 + (panels.length - 1) * 10,
      height: 444,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({ input, left: index * 310, top: 0 })))
    .jpeg({ quality: 90 })
    .toFile(path.join(outputDir, `scene-${sceneId}-compare.jpg`));
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false }).resize({ width: 300, height: 400, fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="44"><rect width="300" height="44" fill="#111827"/><text x="10" y="28" font-family="Arial" font-size="15" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 300, height: 444, channels: 3, background: "#fff" } })
    .composite([{ input: svg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--source") {
      parsed.source = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-dir") {
      parsed.referenceDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
