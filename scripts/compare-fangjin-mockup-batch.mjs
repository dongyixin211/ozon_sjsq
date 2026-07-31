import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceDir = "D:/ozon/商品图/原图";
const psRoot = "D:/ozon/商品图/套图";
const outputDir = path.join(repoRoot, "dist", "ps-compare-batch");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

await fs.mkdir(outputDir, { recursive: true });

const { renderFangjinMockups } = await import(`${rendererPath}?batch=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await discoverSamples();

if (samples.length === 0) {
  throw new Error("没有找到同时包含原图和 6 张 PS 输出的方巾样本");
}

const rows = [];
for (const sample of samples) {
  const sourceBuffer = await fs.readFile(sample.sourcePath);
  const rendered = await renderFangjinMockups({
    sourceBuffer,
    sku: sample.sku,
  });
  const sampleDir = path.join(outputDir, sample.sku);
  await fs.mkdir(sampleDir, { recursive: true });

  for (const scene of rendered.scenes) {
    const cloudPath = path.join(sampleDir, `cloud-${String(scene.index).padStart(2, "0")}${path.extname(scene.filename) || ".png"}`);
    await fs.writeFile(cloudPath, scene.buffer);
    const psPath = sample.psScenePaths.get(scene.index);
    if (!psPath) {
      continue;
    }
    const psDirectBuffer = await sharp(psPath, { animated: false }).toBuffer();
    const psBuffer = await sharp(psDirectBuffer).jpeg({ quality: 92 }).toBuffer();
    const mae = await calculateMae(psBuffer, scene.buffer);
    const directMae = await calculateMae(psDirectBuffer, scene.buffer);
    rows.push({
      sku: sample.sku,
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      directMae: Number(directMae.toFixed(3)),
    });
  }
}

const summary = {
  sampleCount: samples.length,
  sceneCount: rows.length,
  averageMae: roundAverage(rows.map((row) => row.mae)),
  averageDirectMae: roundAverage(rows.map((row) => row.directMae)),
  byScene: summarizeBy(rows, "scene"),
  bySku: summarizeBy(rows, "sku"),
  rows,
};

await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log(`样本数：${summary.sampleCount}`);
console.log(`平均 MAE：${summary.averageMae}`);
console.log(`平均 direct MAE：${summary.averageDirectMae}`);
console.log("按场景汇总：");
console.table(summary.byScene);
console.log("按货号汇总：");
console.table(summary.bySku);
console.log(path.join(outputDir, "summary.json"));

async function discoverSamples() {
  const sourceFiles = await fs.readdir(sourceDir, { withFileTypes: true });
  const sourcePathBySku = new Map();
  for (const entry of sourceFiles) {
    if (!entry.isFile()) {
      continue;
    }
    const parsed = path.parse(entry.name);
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(parsed.ext.toLowerCase())) {
      continue;
    }
    sourcePathBySku.set(parsed.name, path.join(sourceDir, entry.name));
  }

  const psDirs = await fs.readdir(psRoot, { withFileTypes: true });
  const samples = [];
  for (const entry of psDirs) {
    if (!entry.isDirectory() || !sourcePathBySku.has(entry.name)) {
      continue;
    }
    const imageDir = path.join(psRoot, entry.name, "images");
    const psScenePaths = new Map();
    try {
      const files = await fs.readdir(imageDir, { withFileTypes: true });
      for (const file of files) {
        if (!file.isFile()) {
          continue;
        }
        const match = file.name.match(/_(\d{2})\.gif$/i);
        if (match) {
          psScenePaths.set(Number(match[1]), path.join(imageDir, file.name));
        }
      }
    } catch {
      continue;
    }
    if ([1, 2, 3, 4, 5, 6].every((index) => psScenePaths.has(index))) {
      samples.push({
        sku: entry.name,
        sourcePath: sourcePathBySku.get(entry.name),
        psScenePaths,
      });
    }
  }
  return samples.sort((left, right) => left.sku.localeCompare(right.sku));
}

function summarizeBy(rows, key) {
  const buckets = new Map();
  for (const row of rows) {
    const bucketKey = row[key];
    const bucket = buckets.get(bucketKey) ?? [];
    bucket.push(row);
    buckets.set(bucketKey, bucket);
  }
  return [...buckets.entries()]
    .map(([bucketKey, bucketRows]) => ({
      [key]: bucketKey,
      count: bucketRows.length,
      mae: roundAverage(bucketRows.map((row) => row.mae)),
      directMae: roundAverage(bucketRows.map((row) => row.directMae)),
    }))
    .sort((left, right) => {
      if (key === "scene") {
        return Number(left.scene) - Number(right.scene);
      }
      return String(left[key]).localeCompare(String(right[key]));
    });
}

function roundAverage(values) {
  return Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(3));
}

async function calculateMae(psBuffer, cloudBuffer) {
  const [ps, cloud] = await Promise.all([
    sharp(psBuffer).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(cloudBuffer).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  let sum = 0;
  for (let offset = 0; offset < ps.data.length; offset += 3) {
    sum += (
      Math.abs(ps.data[offset] - cloud.data[offset])
      + Math.abs(ps.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(ps.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
  }
  return sum / (ps.data.length / 3);
}
