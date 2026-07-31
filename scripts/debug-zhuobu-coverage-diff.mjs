import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sku = args.sku || "TM20251026002593";
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-coverage-diff"));
const cloudDir = path.resolve(args.cloudDir || path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-current-single"));
const referenceDir = path.resolve(args.referenceDir || `D:/ozon/商品图/桌布/套图/${sku}/images`);
const layersDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu", "layers");
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

await fs.mkdir(outputDir, { recursive: true });
const { default: sharp } = await import(sharpPath);
const sceneLayerMap = await readSceneLayerMap();

const rows = [];
for (let scene = 1; scene <= 8; scene += 1) {
  const baseLayer = sceneLayerMap.get(scene);
  if (!baseLayer) {
    continue;
  }
  const referencePath = path.join(referenceDir, `111_${sku}_${String(scene).padStart(2, "0")}.gif`);
  const cloudPath = path.join(cloudDir, `cloud-${String(scene).padStart(2, "0")}.png`);
  const basePath = path.join(layersDir, baseLayer);
  const [reference, cloud, base] = await Promise.all([
    readRaw(sharp, referencePath),
    readRaw(sharp, cloudPath),
    readRaw(sharp, basePath),
  ]);
  const output = Buffer.alloc(reference.data.length);
  let psPattern = 0;
  let cloudPattern = 0;
  let missed = 0;
  let extra = 0;
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    const psDiff = pixelDiff(reference.data, base.data, offset);
    const cloudDiff = pixelDiff(cloud.data, base.data, offset);
    const psIsPattern = psDiff > 26 && !isNearWhite(reference.data, offset);
    const cloudIsPattern = cloudDiff > 26 && !isNearWhite(cloud.data, offset);
    if (psIsPattern) psPattern += 1;
    if (cloudIsPattern) cloudPattern += 1;
    if (psIsPattern && !cloudIsPattern) {
      missed += 1;
      output[offset] = 245;
      output[offset + 1] = 50;
      output[offset + 2] = 50;
    } else if (!psIsPattern && cloudIsPattern) {
      extra += 1;
      output[offset] = 59;
      output[offset + 1] = 130;
      output[offset + 2] = 246;
    } else if (psIsPattern && cloudIsPattern) {
      output[offset] = 34;
      output[offset + 1] = 197;
      output[offset + 2] = 94;
    } else {
      const grey = Math.round((base.data[offset] + base.data[offset + 1] + base.data[offset + 2]) / 3);
      output[offset] = grey;
      output[offset + 1] = grey;
      output[offset + 2] = grey;
    }
  }
  const total = reference.info.width * reference.info.height;
  const diffPath = path.join(outputDir, `scene-${String(scene).padStart(2, "0")}-coverage-diff.png`);
  await sharp(output, {
    raw: {
      width: reference.info.width,
      height: reference.info.height,
      channels: 3,
    },
  }).png().toFile(diffPath);
  rows.push({
    scene,
    psPatternPct: pct(psPattern, total),
    cloudPatternPct: pct(cloudPattern, total),
    missedPct: pct(missed, total),
    extraPct: pct(extra, total),
    diffPath,
  });
}

console.table(rows.map((row) => ({
  scene: row.scene,
  psPatternPct: row.psPatternPct,
  cloudPatternPct: row.cloudPatternPct,
  missedPct: row.missedPct,
  extraPct: row.extraPct,
})));
console.log(outputDir);

async function readSceneLayerMap() {
  const template = JSON.parse(await fs.readFile(path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu", "template.json"), "utf8"));
  const output = new Map();
  for (const scene of template.scenes) {
    const base = scene.layers
      .filter((layer) => layer.kind === "image" && layer.blendMode === "normal" && layer.width === 800 && layer.height === 1067)
      .sort((left, right) => left.order - right.order)[0];
    if (base?.file) {
      output.set(scene.index, base.file.replace(/^layers[\\/]/, ""));
    }
  }
  return output;
}

async function readRaw(sharp, inputPath) {
  return sharp(inputPath, { animated: false })
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

function pct(value, total) {
  return Number(((value / total) * 100).toFixed(2));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--sku") {
      parsed.sku = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--cloud-dir") {
      parsed.cloudDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-dir") {
      parsed.referenceDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
