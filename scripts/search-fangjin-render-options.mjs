import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceDir = "D:/ozon/商品图/原图";
const psRoot = "D:/ozon/商品图/套图";
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

const options = parseArgs(process.argv.slice(2));
const sceneIndexes = options.scenes.length ? options.scenes : [1, 2, 3, 4, 5, 6];
const candidates = options.candidates.length ? options.candidates : defaultCandidates();

const { default: sharp } = await import(sharpPath);
const { renderFangjinMockups } = await import(`${rendererPath}?renderOptions=${Date.now()}`);
const samples = (await discoverSamples()).slice(0, options.sampleLimit || undefined);
const sampleInputs = await Promise.all(samples.map(async (sample) => ({
  ...sample,
  sourceBuffer: await fs.readFile(sample.sourcePath),
  psDirectByScene: new Map(await Promise.all(sceneIndexes.map(async (sceneIndex) => [
    sceneIndex,
    await sharp(sample.psScenePaths.get(sceneIndex), { animated: false }).toBuffer(),
  ]))),
})));

if (sampleInputs.length === 0) {
  throw new Error("没有找到可用于对比的完整 PS 样本。");
}

for (const sceneIndex of sceneIndexes) {
  const rows = [];
  for (const candidate of candidates) {
    const values = [];
    for (const sample of sampleInputs) {
      const rendered = await renderFangjinMockups({
        sourceBuffer: sample.sourceBuffer,
        sku: sample.sku,
        sceneIndexes: [sceneIndex],
        perspectiveSampleMode: candidate.perspectiveSampleMode,
        perspectiveInterpolation: candidate.perspectiveInterpolation,
      });
      const scene = rendered.scenes[0];
      if (!scene) {
        throw new Error(`未渲染出场景 ${sceneIndex}`);
      }
      values.push(await calculateMae(sample.psDirectByScene.get(sceneIndex), scene.buffer));
    }
    rows.push({
      scene: sceneIndex,
      candidate: candidate.label,
      directMae: round(average(values)),
    });
  }
  rows.sort((left, right) => left.directMae - right.directMae);
  console.log(`场景 ${sceneIndex}，样本数 ${sampleInputs.length}`);
  console.table(rows.slice(0, options.top));
}

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
    if (sceneIndexes.every((sceneIndex) => psScenePaths.has(sceneIndex))) {
      samples.push({
        sku: entry.name,
        sourcePath: sourcePathBySku.get(entry.name),
        psScenePaths,
      });
    }
  }
  return samples.sort((left, right) => left.sku.localeCompare(right.sku));
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

function defaultCandidates() {
  return [
    { label: "template" },
    { label: "edge/bilinear", perspectiveSampleMode: "edge", perspectiveInterpolation: "bilinear" },
    { label: "center/bilinear", perspectiveSampleMode: "center", perspectiveInterpolation: "bilinear" },
    { label: "edge/supersample4", perspectiveSampleMode: "edge", perspectiveInterpolation: "supersample4" },
    { label: "center/supersample4", perspectiveSampleMode: "center", perspectiveInterpolation: "supersample4" },
    { label: "center/supersample5", perspectiveSampleMode: "center", perspectiveInterpolation: "supersample5" },
    { label: "center/mitchell", perspectiveSampleMode: "center", perspectiveInterpolation: "mitchell" },
  ];
}

function parseArgs(args) {
  const parsed = {
    scenes: [],
    candidates: [],
    sampleLimit: 0,
    top: 12,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--scenes") {
      parsed.scenes = splitNumbers(args[index + 1] || "");
      index += 1;
      continue;
    }
    if (arg === "--sample-limit") {
      parsed.sampleLimit = Number(args[index + 1] || 0);
      index += 1;
      continue;
    }
    if (arg === "--top") {
      parsed.top = Math.max(1, Number(args[index + 1] || 12));
      index += 1;
      continue;
    }
    if (arg === "--candidates") {
      parsed.candidates = splitCandidates(args[index + 1] || "");
      index += 1;
      continue;
    }
  }
  return parsed;
}

function splitNumbers(value) {
  return value
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function splitCandidates(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((label) => {
      if (label === "template") {
        return { label };
      }
      const [perspectiveSampleMode, perspectiveInterpolation] = label.split("/");
      return { label, perspectiveSampleMode, perspectiveInterpolation };
    });
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value) {
  return Number(value.toFixed(3));
}
