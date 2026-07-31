import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-color-calibration"));
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT ||= path.join(repoRoot, "server", "src", "mockup-templates");

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

const { renderMockupsWithTemplate } = await import(`${rendererPath}?colorCalibration=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sceneIndexes = (args.scenes || "1,2,4,5,6,7,8")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter(Boolean);

const samples = [];
for (const file of (await fs.readdir(sourceDir)).filter((item) => /\.(png|jpe?g|webp)$/i.test(item)).sort()) {
  const sku = path.basename(file, path.extname(file));
  const refs = await completeReferenceFiles(referenceRoot, sku);
  if (!refs) continue;
  samples.push({ sku, sourcePath: path.join(sourceDir, file), refs });
}

const sceneData = new Map();
for (const sceneIndex of sceneIndexes) {
  sceneData.set(sceneIndex, []);
}

for (const sample of samples) {
  const rendered = await renderMockupsWithTemplate({
    templateDir: "zhuobu",
    sourceBuffer: await fs.readFile(sample.sourcePath),
    sku: sample.sku,
    sceneIndexes,
  });
  for (const scene of rendered.scenes) {
    const referenceBuffer = await fs.readFile(sample.refs[scene.index]);
    const [cloud, reference] = await Promise.all([
      readRgb(sharp, scene.buffer),
      readRgb(sharp, referenceBuffer),
    ]);
    sceneData.get(scene.index).push({
      sku: sample.sku,
      cloud,
      reference,
    });
  }
}

const summaries = [];
for (const sceneIndex of sceneIndexes) {
  const items = sceneData.get(sceneIndex);
  const calibration = fitRgbCalibration(items);
  const rows = [];
  for (const item of items) {
    const beforeMae = calculateMaeRaw(item.reference.data, item.cloud.data);
    const afterData = applyCalibration(item.cloud.data, calibration);
    const afterMae = calculateMaeRaw(item.reference.data, afterData);
    rows.push({
      sku: item.sku,
      before: Number((100 - (beforeMae / 255) * 100).toFixed(2)),
      after: Number((100 - (afterMae / 255) * 100).toFixed(2)),
      diff: Number((((beforeMae - afterMae) / 255) * 100).toFixed(3)),
    });
  }
  const summary = {
    scene: sceneIndex,
    calibration,
    beforeAverage: Number(average(rows.map((row) => row.before)).toFixed(2)),
    afterAverage: Number(average(rows.map((row) => row.after)).toFixed(2)),
    beforeWorst: Number(Math.min(...rows.map((row) => row.before)).toFixed(2)),
    afterWorst: Number(Math.min(...rows.map((row) => row.after)).toFixed(2)),
    rows,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    scene: sceneIndex,
    before: summary.beforeAverage,
    after: summary.afterAverage,
    worstBefore: summary.beforeWorst,
    worstAfter: summary.afterWorst,
    calibration,
  }));
}

await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.map((item) => ({
  scene: item.scene,
  before: item.beforeAverage,
  after: item.afterAverage,
  worstBefore: item.beforeWorst,
  worstAfter: item.afterWorst,
  gain: Number((item.afterAverage - item.beforeAverage).toFixed(2)),
})));
console.log(path.join(outputDir, "summary.json"));

async function completeReferenceFiles(root, sku) {
  for (const refDir of [path.join(root, sku), path.join(root, sku, "images")]) {
    const refs = {};
    let complete = true;
    for (let scene = 1; scene <= 9; scene += 1) {
      const file = path.join(refDir, `111_${sku}_${String(scene).padStart(2, "0")}.gif`);
      try {
        await fs.access(file);
        refs[scene] = file;
      } catch {
        complete = false;
        break;
      }
    }
    if (complete) return refs;
  }
  return null;
}

async function readRgb(sharp, input) {
  return sharp(input, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function fitRgbCalibration(items) {
  const output = [];
  for (let channel = 0; channel < 3; channel += 1) {
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    for (const item of items) {
      const cloud = item.cloud.data;
      const reference = item.reference.data;
      for (let offset = channel; offset < cloud.length; offset += 3) {
        const x = cloud[offset];
        const y = reference[offset];
        sumX += x;
        sumY += y;
        sumXX += x * x;
        sumXY += x * y;
        count += 1;
      }
    }
    const denominator = count * sumXX - sumX * sumX;
    const scale = Math.abs(denominator) < 1e-6 ? 1 : (count * sumXY - sumX * sumY) / denominator;
    const offset = (sumY - scale * sumX) / Math.max(1, count);
    output.push({
      scale: Number(clamp(scale, 0.85, 1.15).toFixed(5)),
      offset: Number(clamp(offset, -20, 20).toFixed(3)),
    });
  }
  return output;
}

function applyCalibration(data, calibration) {
  const output = Buffer.from(data);
  for (let offset = 0; offset < output.length; offset += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      const item = calibration[channel];
      output[offset + channel] = clampByte(Math.round(output[offset + channel] * item.scale + item.offset));
    }
  }
  return output;
}

function calculateMaeRaw(reference, cloud) {
  let sum = 0;
  for (let offset = 0; offset < reference.length; offset += 3) {
    sum += (
      Math.abs(reference[offset] - cloud[offset])
      + Math.abs(reference[offset + 1] - cloud[offset + 1])
      + Math.abs(reference[offset + 2] - cloud[offset + 2])
    ) / 3;
  }
  return sum / (reference.length / 3);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, value));
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
    } else if (value === "--scenes") {
      parsed.scenes = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
