import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene7-reference-mask-batch"));
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

const sceneIndex = 7;
const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const baseTemplate = JSON.parse(await fs.readFile(path.join(baseDir, "template.json"), "utf8"));
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?scene7ReferenceMaskBatch=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const samples = await collectSamples(sourceDir, referenceRoot);
if (!samples.length) {
  throw new Error("没有找到可用的桌布样本");
}

const masks = await buildReferenceMasks(sharp, samples, Number(args.threshold || 18));
for (const [name, buffer] of Object.entries(masks)) {
  await fs.writeFile(path.join(outputDir, `scene-07-${name}.png`), buffer);
}

const candidates = [
  ["baseline", () => {}],
  ["mask-union", (template) => applyMaskCandidate(template, "union")],
  ["mask-majority", (template) => applyMaskCandidate(template, "majority")],
  ["mask-soft", (template) => applyMaskCandidate(template, "soft")],
  ["mask-intersection", (template) => applyMaskCandidate(template, "intersection")],
  ["mask-union-one-layer", (template) => {
    applyMaskCandidate(template, "union");
    keepTopReplaceLayer(template);
  }],
  ["mask-majority-one-layer", (template) => {
    applyMaskCandidate(template, "majority");
    keepTopReplaceLayer(template);
  }],
  ["mask-soft-one-layer", (template) => {
    applyMaskCandidate(template, "soft");
    keepTopReplaceLayer(template);
  }],
  ["mask-union-no-linear", (template) => {
    applyMaskCandidate(template, "union");
    scene(template).linearLightStrength = 0;
  }],
  ["mask-union-one-layer-no-linear", (template) => {
    applyMaskCandidate(template, "union");
    keepTopReplaceLayer(template);
    scene(template).linearLightStrength = 0;
  }],
];

const summaries = [];
for (const [name, mutate] of candidates) {
  const targetDir = path.join(templateRoot, name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  await fs.mkdir(path.join(targetDir, "masks"), { recursive: true });
  for (const [maskName, buffer] of Object.entries(masks)) {
    await fs.writeFile(path.join(targetDir, "masks", `scene-07-${maskName}.png`), buffer);
  }
  const template = structuredClone(baseTemplate);
  mutate(template);
  normalizeSceneOrders(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(name);

  const rows = [];
  for (const sample of samples) {
    const sourceBuffer = await fs.readFile(sample.sourcePath);
    const rendered = await renderMockupsWithTemplate({ templateDir: name, sourceBuffer, sku: sample.sku, sceneIndexes: [sceneIndex] });
    const renderedScene = rendered.scenes[0];
    if (args.keepImages === "true") {
      await fs.writeFile(path.join(outputDir, `${name}-${sample.sku}-cloud-07.png`), renderedScene.buffer);
    }
    const referenceBuffer = await fs.readFile(sample.refs[sceneIndex]);
    const mae = await calculateMae(sharp, referenceBuffer, renderedScene.buffer);
    rows.push({
      sku: sample.sku,
      scene: sceneIndex,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
  }
  const summary = {
    name,
    averageSimilarity: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
    rows,
  };
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}

summaries.sort((left, right) => right.averageSimilarity - left.averageSimilarity);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");

console.table(summaries.map((item) => ({
  name: item.name,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
})));
console.log(path.join(outputDir, "summary.json"));

async function collectSamples(sourceDir, referenceRoot) {
  const files = (await fs.readdir(sourceDir))
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    .sort();
  const output = [];
  for (const file of files) {
    const sku = path.basename(file, path.extname(file));
    const refs = await completeReferenceFiles(referenceRoot, sku);
    if (!refs) continue;
    output.push({ sku, sourcePath: path.join(sourceDir, file), refs });
  }
  return output;
}

async function completeReferenceFiles(root, sku) {
  for (const refDir of [path.join(root, sku), path.join(root, sku, "images")]) {
    const refs = {};
    let complete = true;
    for (let item = 1; item <= 9; item += 1) {
      const file = path.join(refDir, `111_${sku}_${String(item).padStart(2, "0")}.gif`);
      try {
        await fs.access(file);
        refs[item] = file;
      } catch {
        complete = false;
        break;
      }
    }
    if (complete) {
      return refs;
    }
  }
  return null;
}

async function buildReferenceMasks(sharp, samples, threshold) {
  const baseLayer = scene(baseTemplate).layers.find((layer) => (
    layer.kind === "image" && layer.blendMode === "normal" && layer.width === 800 && layer.height === 1067
  ));
  if (!baseLayer?.file) throw new Error("scene 7 base layer not found");
  const base = await rawRgb(sharp, await fs.readFile(path.join(baseDir, baseLayer.file)));
  const counts = Buffer.alloc(base.info.width * base.info.height);
  for (const sample of samples) {
    const reference = await rawRgb(sharp, await fs.readFile(sample.refs[sceneIndex]));
    for (let source = 0, target = 0; source < reference.data.length; source += 3, target += 1) {
      const diff = pixelDiff(reference.data, base.data, source);
      if (diff > threshold && !isNearWhite(reference.data, source)) {
        counts[target] += 1;
      }
    }
  }
  const total = samples.length;
  return {
    union: await writeMask(sharp, counts, base.info.width, base.info.height, (count) => count >= 1 ? 255 : 0),
    majority: await writeMask(sharp, counts, base.info.width, base.info.height, (count) => count >= Math.ceil(total / 2) ? 255 : 0),
    intersection: await writeMask(sharp, counts, base.info.width, base.info.height, (count) => count === total ? 255 : 0),
    soft: await writeMask(sharp, counts, base.info.width, base.info.height, (count) => Math.round((count / total) * 255)),
  };
}

async function writeMask(sharp, counts, width, height, mapValue) {
  const output = Buffer.alloc(counts.length);
  for (let index = 0; index < counts.length; index += 1) {
    output[index] = mapValue(counts[index]);
  }
  return sharp(output, { raw: { width, height, channels: 1 } })
    .median(3)
    .blur(0.4)
    .png()
    .toBuffer();
}

function applyMaskCandidate(template, maskName) {
  for (const layer of scene(template).layers) {
    if (layer.kind !== "replace") continue;
    layer.mask = `masks/scene-07-${maskName}.png`;
    layer.maskLeft = 0;
    layer.maskTop = 0;
    layer.maskWidth = 800;
    layer.maskHeight = 1067;
  }
}

function keepTopReplaceLayer(template) {
  const targetScene = scene(template);
  const replaceLayers = targetScene.layers.filter((layer) => layer.kind === "replace").sort((left, right) => left.order - right.order);
  const keep = replaceLayers[0];
  targetScene.layers = targetScene.layers.filter((layer) => layer.kind !== "replace" || layer === keep);
}

function scene(template) {
  const targetScene = template.scenes.find((item) => item.index === sceneIndex);
  if (!targetScene) throw new Error(`scene ${sceneIndex} not found`);
  return targetScene;
}

function normalizeSceneOrders(template) {
  const targetScene = scene(template);
  targetScene.layers.sort((left, right) => left.order - right.order).forEach((layer, index) => {
    layer.order = index;
  });
}

async function calculateMae(sharp, referenceBuffer, cloudBuffer) {
  const reference = await rawRgb(sharp, referenceBuffer);
  const cloud = await rawRgb(sharp, cloudBuffer);
  let sum = 0;
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    sum += pixelDiff(reference.data, cloud.data, offset);
  }
  return sum / (reference.data.length / 3);
}

async function rawRgb(sharp, input) {
  return sharp(input, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function pixelDiff(left, right, offset) {
  return (
    Math.abs(left[offset] - right[offset])
    + Math.abs(left[offset + 1] - right[offset + 1])
    + Math.abs(left[offset + 2] - right[offset + 2])
  ) / 3;
}

function isNearWhite(data, offset) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  return r > 225 && g > 225 && b > 225 && Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--source-dir") {
      parsed.sourceDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-root") {
      parsed.referenceRoot = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--threshold") {
      parsed.threshold = values[index + 1] || "";
      index += 1;
    } else if (value === "--keep-images") {
      parsed.keepImages = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
