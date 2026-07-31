import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/\u5546\u54c1\u56fe/\u684c\u5e03/\u539f\u56fe");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/\u5546\u54c1\u56fe/\u684c\u5e03/\u5957\u56fe");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-batch-compare"));
const warnThreshold = Number(args.warnThreshold || 92);
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT ||= path.join(repoRoot, "server", "src", "mockup-templates");

await fs.mkdir(outputDir, { recursive: true });
const { renderMockupsWithTemplate } = await import(`${rendererPath}?zhuobuBatch=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const sourceFiles = (await fs.readdir(sourceDir))
  .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
  .sort();

const rows = [];
for (const file of sourceFiles) {
  const sku = path.basename(file, path.extname(file));
  const refDir = path.join(referenceRoot, sku, "images");
  const refs = await completeReferenceFiles(refDir, sku);
  if (!refs) {
    console.log(`skip ${sku}: missing PS reference images`);
    continue;
  }
  const sourceBuffer = await fs.readFile(path.join(sourceDir, file));
  const rendered = await renderMockupsWithTemplate({ templateDir: "zhuobu", sourceBuffer, sku });
  const sampleRows = [];
  for (const scene of rendered.scenes) {
    const referenceBuffer = await fs.readFile(refs[scene.index]);
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    sampleRows.push({
      sku,
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
  }
  rows.push(...sampleRows);
  const averageSimilarity = average(sampleRows.map((row) => row.similarity));
  const lowScenes = sampleRows.filter((row) => row.similarity < warnThreshold);
  console.log(`${sku} average ${averageSimilarity.toFixed(2)}%${lowScenes.length ? `, low: ${lowScenes.map((row) => `${row.scene}(${row.similarity}%)`).join(", ")}` : ""}`);
}

const byScene = new Map();
for (const row of rows) {
  if (!byScene.has(row.scene)) {
    byScene.set(row.scene, []);
  }
  byScene.get(row.scene).push(row);
}

const sceneSummary = [...byScene.entries()]
  .sort(([left], [right]) => left - right)
  .map(([scene, items]) => ({
    scene,
    samples: items.length,
    mae: Number(average(items.map((item) => item.mae)).toFixed(3)),
    similarity: Number(average(items.map((item) => item.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...items.map((item) => item.similarity)).toFixed(2)),
    status: Math.min(...items.map((item) => item.similarity)) < warnThreshold ? "LOW" : "OK",
  }));
const summary = {
  samples: new Set(rows.map((row) => row.sku)).size,
  rows: rows.length,
  averageMae: Number(average(rows.map((row) => row.mae)).toFixed(3)),
  averageSimilarity: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
  worstSimilarity: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
  warnThreshold,
  sceneSummary,
};

await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ summary, rows }, null, 2)}\n`, "utf8");
console.table(sceneSummary);
console.log(`samples: ${summary.samples}`);
console.log(`average mae: ${summary.averageMae}`);
console.log(`average similarity: ${summary.averageSimilarity}%`);
console.log(`worst similarity: ${summary.worstSimilarity}%`);

async function completeReferenceFiles(refDir, sku) {
  const output = {};
  for (let scene = 1; scene <= 9; scene += 1) {
    const file = path.join(refDir, `111_${sku}_${String(scene).padStart(2, "0")}.gif`);
    try {
      await fs.access(file);
      output[scene] = file;
    } catch {
      return null;
    }
  }
  return output;
}

async function calculateMae(sharp, referenceBuffer, cloudBuffer) {
  const reference = await sharp(referenceBuffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cloud = await sharp(cloudBuffer)
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
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
    } else if (value === "--warn-threshold") {
      parsed.warnThreshold = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
