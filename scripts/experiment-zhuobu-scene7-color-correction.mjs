import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene7-color-correction"));
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;
const maskPath = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu", "masks", "scene-07-reference-union.png");

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT ||= path.join(repoRoot, "server", "src", "mockup-templates");

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

const { renderMockupsWithTemplate } = await import(`${rendererPath}?zhuobuScene7ColorCorrection=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await collectSamples(sourceDir, referenceRoot);
if (!samples.length) {
  throw new Error("没有找到可用于 scene 7 色彩校正实验的桌布样本");
}

const mask = await rawMask(sharp, await fs.readFile(maskPath));
const renderedSamples = [];
for (const sample of samples) {
  const sourceBuffer = await fs.readFile(sample.sourcePath);
  const rendered = await renderMockupsWithTemplate({
    templateDir: "zhuobu",
    sourceBuffer,
    sku: sample.sku,
    sceneIndexes: [7],
  });
  const cloudBuffer = rendered.scenes[0].buffer;
  const referenceBuffer = await fs.readFile(sample.refs[7]);
  const cloud = await rawRgb(sharp, cloudBuffer);
  const reference = await rawRgb(sharp, referenceBuffer);
  renderedSamples.push({ ...sample, cloudBuffer, cloud, reference });
  if (args.keepImages === "true") {
    await fs.writeFile(path.join(outputDir, `baseline-${sample.sku}-cloud-07.png`), cloudBuffer);
  }
}

const fits = {
  all: fitRgbAffine(renderedSamples, () => 1),
  mask: fitRgbAffine(renderedSamples, (_sample, pixel) => mask.data[pixel] / 255),
  maskHard: fitRgbAffine(renderedSamples, (_sample, pixel) => (mask.data[pixel] > 32 ? 1 : 0)),
};

const candidates = [{ name: "baseline", mutate: (_sample) => null, meta: {} }];
for (const [fitName, fit] of Object.entries(fits)) {
  for (const applyMode of ["all", "mask", "maskHard"]) {
    for (const strength of [0.25, 0.5, 0.75, 1]) {
      candidates.push({
        name: `${fitName}-to-${applyMode}-s${slugNumber(strength)}`,
        meta: { fit: fitName, apply: applyMode, strength, coefficients: fit },
        mutate: (sample) => applyCorrection(sharp, sample.cloud, fit, applyMode, strength, mask),
      });
    }
  }
}

const summaries = [];
for (const candidate of candidates) {
  const rows = [];
  for (const sample of renderedSamples) {
    const corrected = candidate.mutate(sample);
    const correctedBuffer = corrected ? await corrected : sample.cloudBuffer;
    if (args.keepImages === "true") {
      await fs.writeFile(path.join(outputDir, `${candidate.name}-${sample.sku}-cloud-07.png`), correctedBuffer);
    }
    const mae = await calculateMae(sharp, sample.reference.buffer, correctedBuffer);
    rows.push({
      sku: sample.sku,
      scene: 7,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
  }
  const summary = {
    name: candidate.name,
    meta: candidate.meta,
    averageSimilarity: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
    rows,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    averageSimilarity: summary.averageSimilarity,
    worstSimilarity: summary.worstSimilarity,
    meta: summary.meta,
  }));
}

summaries.sort((left, right) => right.averageSimilarity - left.averageSimilarity || right.worstSimilarity - left.worstSimilarity);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), fits, summaries }, null, 2)}\n`, "utf8");
console.table(summaries.slice(0, 30).map((item) => ({
  name: item.name,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
  fit: item.meta.fit,
  apply: item.meta.apply,
  strength: item.meta.strength,
})));
console.log(path.join(outputDir, "summary.json"));

function fitRgbAffine(samples, weightForPixel) {
  const fits = [];
  for (let channel = 0; channel < 3; channel += 1) {
    let sumW = 0;
    let sumX = 0;
    let sumY = 0;
    let sumXX = 0;
    let sumXY = 0;
    for (const sample of samples) {
      const pixels = sample.cloud.data.length / 3;
      for (let pixel = 0, offset = channel; pixel < pixels; pixel += 1, offset += 3) {
        const weight = weightForPixel(sample, pixel);
        if (weight <= 0) continue;
        const x = sample.cloud.data[offset];
        const y = sample.reference.data[offset];
        sumW += weight;
        sumX += weight * x;
        sumY += weight * y;
        sumXX += weight * x * x;
        sumXY += weight * x * y;
      }
    }
    const denom = sumW * sumXX - sumX * sumX;
    const a = Math.abs(denom) > 1e-6 ? ((sumW * sumXY - sumX * sumY) / denom) : 1;
    const b = (sumY - a * sumX) / Math.max(1, sumW);
    fits.push({ a: round(a), b: round(b) });
  }
  return fits;
}

async function applyCorrection(sharp, cloud, fit, applyMode, strength, mask) {
  const output = Buffer.from(cloud.data);
  const pixels = cloud.data.length / 3;
  for (let pixel = 0, offset = 0; pixel < pixels; pixel += 1, offset += 3) {
    const applyWeight = applyMode === "all"
      ? 1
      : applyMode === "maskHard"
        ? (mask.data[pixel] > 32 ? 1 : 0)
        : mask.data[pixel] / 255;
    if (applyWeight <= 0) continue;
    const mix = strength * applyWeight;
    for (let channel = 0; channel < 3; channel += 1) {
      const oldValue = output[offset + channel];
      const corrected = clampByte(fit[channel].a * oldValue + fit[channel].b);
      output[offset + channel] = clampByte(oldValue * (1 - mix) + corrected * mix);
    }
  }
  return sharp(output, {
    raw: {
      width: cloud.info.width,
      height: cloud.info.height,
      channels: 3,
    },
  }).png().toBuffer();
}

async function collectSamples(root, referenceRoot) {
  const files = (await fs.readdir(root))
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    .sort();
  const output = [];
  for (const file of files) {
    const sku = path.basename(file, path.extname(file));
    const refs = await completeReferenceFiles(referenceRoot, sku);
    if (!refs) continue;
    output.push({ sku, sourcePath: path.join(root, file), refs });
  }
  return output;
}

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
    if (complete) {
      return refs;
    }
  }
  return null;
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
  const result = await sharp(input, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { ...result, buffer: input };
}

async function rawMask(sharp, input) {
  return sharp(input)
    .resize(800, 1067, { fit: "fill" })
    .ensureAlpha()
    .extractChannel("red")
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

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

function slugNumber(value) {
  return String(value).replace("-", "m").replace(".", "p");
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
    } else if (value === "--keep-images") {
      parsed.keepImages = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
