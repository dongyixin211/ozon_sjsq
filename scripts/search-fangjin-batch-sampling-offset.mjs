import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceDir = "D:/ozon/商品图/原图";
const psRoot = "D:/ozon/商品图/套图";
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

const sceneIndex = Number(process.argv[2] || 3);
const xValues = (process.argv[3] || "-0.375,-0.25,-0.125,0,0.125").split(",").map(Number);
const yValues = (process.argv[4] || "-1.25,-1.125,-1,-0.875,-0.75,-0.625").split(",").map(Number);
const optionArgs = parseOptionArgs(process.argv.slice(5));
const outputPath = optionArgs.output
  ? path.resolve(repoRoot, optionArgs.output)
  : "";

process.env.MOCKUP_SCENE_FILTER = String(sceneIndex);
const { default: sharp } = await import(sharpPath);
const { renderFangjinMockups } = await import(`${rendererPath}?batchOffset=${sceneIndex}_${Date.now()}`);
const samples = (await discoverSamples()).slice(0, optionArgs.sampleLimit || undefined);
const sampleInputs = await Promise.all(samples.map(async (sample) => ({
  ...sample,
  sourceBuffer: await fs.readFile(sample.sourcePath),
  psDirectBuffer: await sharp(sample.psScenePath, { animated: false }).toBuffer(),
})));

const rows = [];
let searched = 0;
const total = xValues.length * yValues.length;
if (outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, "", "utf8");
}
for (const offsetX of xValues) {
  for (const offsetY of yValues) {
    const metrics = [];
    for (const sample of sampleInputs) {
      const rendered = await renderFangjinMockups({
        sourceBuffer: sample.sourceBuffer,
        sku: sample.sku,
        perspectivePixelOffsetX: offsetX,
        perspectivePixelOffsetY: offsetY,
        perspectiveSampleMode: optionArgs.perspectiveSampleMode,
        perspectiveInterpolation: optionArgs.perspectiveInterpolation,
        sceneIndexes: [sceneIndex],
      });
      const scene = rendered.scenes.find((item) => item.index === sceneIndex);
      if (!scene) {
        throw new Error(`未找到场景 ${sceneIndex}`);
      }
      metrics.push(await calculateMae(sample.psDirectBuffer, scene.buffer));
    }
    rows.push({
      offsetX,
      offsetY,
      directMae: Number(average(metrics).toFixed(3)),
    });
    searched += 1;
    rows.sort((left, right) => left.directMae - right.directMae);
    const best = rows[0];
    const current = rows.find((row) => row.offsetX === offsetX && row.offsetY === offsetY);
    const progressText = `[${searched}/${total}] x=${offsetX}, y=${offsetY}, directMae=${current.directMae}; best x=${best.offsetX}, y=${best.offsetY}, directMae=${best.directMae}`;
    console.log(progressText);
    if (outputPath) {
      await fs.appendFile(outputPath, `${JSON.stringify({ scene: sceneIndex, offsetX, offsetY, directMae: current.directMae })}\n`, "utf8");
    }
  }
}

delete process.env.MOCKUP_SCENE_FILTER;

rows.sort((left, right) => left.directMae - right.directMae);
console.log(`样本数：${samples.length}，场景：${sceneIndex}`);
if (optionArgs.perspectiveSampleMode || optionArgs.perspectiveInterpolation) {
  console.log(`采样：${optionArgs.perspectiveSampleMode || "template"} / ${optionArgs.perspectiveInterpolation || "template"}`);
}
console.table(rows.slice(0, 20));

function parseOptionArgs(args) {
  const parsed = {
    perspectiveSampleMode: undefined,
    perspectiveInterpolation: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--sample-mode") {
      parsed.perspectiveSampleMode = args[index + 1] || undefined;
      index += 1;
      continue;
    }
    if (arg === "--interpolation") {
      parsed.perspectiveInterpolation = args[index + 1] || undefined;
      index += 1;
      continue;
    }
    if (arg === "--sample-limit") {
      parsed.sampleLimit = Number(args[index + 1] || 0);
      index += 1;
      continue;
    }
    if (arg === "--output") {
      parsed.output = args[index + 1] || "";
      index += 1;
      continue;
    }
  }
  return parsed;
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
    const psScenePath = path.join(psRoot, entry.name, "images", `111_${entry.name}_${String(sceneIndex).padStart(2, "0")}.gif`);
    try {
      await fs.access(psScenePath);
    } catch {
      continue;
    }
    samples.push({
      sku: entry.name,
      sourcePath: sourcePathBySku.get(entry.name),
      psScenePath,
    });
  }
  return samples.sort((left, right) => left.sku.localeCompare(right.sku));
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
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
