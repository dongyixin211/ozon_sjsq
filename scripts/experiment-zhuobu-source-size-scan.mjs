import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-source-size-scan"));
const templateRoot = path.join(outputDir, "templates");
const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;
const sceneIndexes = (args.scenes || "1,5,7")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT = templateRoot;

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(templateRoot, { recursive: true });

const baseTemplate = JSON.parse(await fs.readFile(path.join(baseDir, "template.json"), "utf8"));
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuSourceSizeScan=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await collectSamples(sourceDir, referenceRoot);

if (!samples.length) {
  throw new Error("没有找到可用于源图尺寸扫描的完整桌布样本。");
}

const candidates = buildCandidates();
const summaries = [];

for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  template.sourceWidth = candidate.width;
  template.sourceHeight = candidate.height;
  template.sourceFit = candidate.fit;
  if (candidate.kernel) {
    template.sourceResizeKernel = candidate.kernel;
  } else {
    delete template.sourceResizeKernel;
  }
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rows = [];
  for (const sample of samples) {
    const rendered = await renderMockupsWithTemplate({
      templateDir: candidate.name,
      sourceBuffer: await fs.readFile(sample.sourcePath),
      sku: sample.sku,
      sceneIndexes,
    });
    for (const scene of rendered.scenes) {
      if (args.keepImages === "true") {
        await fs.writeFile(path.join(outputDir, `${candidate.name}-${sample.sku}-cloud-${String(scene.index).padStart(2, "0")}.png`), scene.buffer);
      }
      const referenceBuffer = await fs.readFile(sample.refs[scene.index]);
      const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
      rows.push({
        sku: sample.sku,
        scene: scene.index,
        mae: Number(mae.toFixed(3)),
        similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
      });
    }
  }

  const summary = summarize(candidate, rows);
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    averageSimilarity: summary.averageSimilarity,
    worstSimilarity: summary.worstSimilarity,
    sceneSummary: summary.sceneSummary,
    candidate,
  }));
}

summaries.sort((left, right) => (
  right.averageSimilarity - left.averageSimilarity
  || right.worstSimilarity - left.worstSimilarity
));

await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ scenes: sceneIndexes, samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.map((item) => ({
  name: item.name,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
  width: item.width,
  height: item.height,
  fit: item.fit,
  kernel: item.kernel || "",
  scenes: item.sceneSummary.map((scene) => `${scene.scene}:${scene.similarity}/${scene.worstSimilarity}`).join(" "),
})));
console.log(path.join(outputDir, "summary.json"));

function buildCandidates() {
  const dims = [
    [1600, 960, "fill"],
    [1536, 1024, "fill"],
    [1500, 1000, "fill"],
    [1440, 960, "fill"],
    [1600, 1067, "fill"],
    [1536, 960, "fill"],
    [1600, 1024, "fill"],
    [1800, 1080, "fill"],
    [1600, 960, "cover"],
    [1536, 1024, "cover"],
  ];
  const output = [];
  for (const [width, height, fit] of dims) {
    output.push({ name: `src-${width}x${height}-${fit}`, width, height, fit });
  }
  for (const kernel of ["cubic", "mitchell", "lanczos2", "lanczos3"]) {
    output.push({ name: `src-1600x960-fill-${kernel}`, width: 1600, height: 960, fit: "fill", kernel });
  }
  return output;
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
    if (complete) return refs;
  }
  return null;
}

function summarize(candidate, rows) {
  const sceneSummary = [];
  for (const scene of sceneIndexes) {
    const sceneRows = rows.filter((row) => row.scene === scene);
    sceneSummary.push({
      scene,
      similarity: Number(average(sceneRows.map((row) => row.similarity)).toFixed(2)),
      worstSimilarity: Number(Math.min(...sceneRows.map((row) => row.similarity)).toFixed(2)),
    });
  }
  return {
    ...candidate,
    averageSimilarity: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
    sceneSummary,
    rows,
  };
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

async function rawRgb(sharp, input) {
  return sharp(input, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
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
    } else if (value === "--scenes") {
      parsed.scenes = values[index + 1] || "";
      index += 1;
    } else if (value === "--keep-images") {
      parsed.keepImages = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
