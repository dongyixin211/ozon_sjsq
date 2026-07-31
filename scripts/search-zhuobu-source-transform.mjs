import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-source-transform-search"));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251026002593.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251026002593/images");
const scenes = (args.scenes || "1,2,4,5,6,7,8").split(",").map((value) => Number(value.trim())).filter(Boolean);
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
const { renderMockupsWithTemplate } = await import(`${rendererPath}?zhuobuSourceSearch=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);

const candidates = createCandidates();
const baseline = await scoreCandidate({ label: "baseline" });
const results = [];
for (const candidate of candidates) {
  const score = await scoreCandidate(candidate);
  results.push(score);
  console.log(JSON.stringify({
    label: score.label,
    average: score.averageSimilarity,
    worst: score.worstSimilarity,
    improved: Number((score.averageSimilarity - baseline.averageSimilarity).toFixed(2)),
  }));
}

results.sort((left, right) => right.averageSimilarity - left.averageSimilarity);
const summary = { baseline, results };
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.table(results.slice(0, 20).map((item) => ({
  label: item.label,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
  diff: Number((item.averageSimilarity - baseline.averageSimilarity).toFixed(2)),
})));

async function scoreCandidate(candidate) {
  const source = await prepareSource(candidate);
  const rendered = await renderMockupsWithTemplate({
    templateDir: "zhuobu",
    sourceBuffer: source,
    sku,
    sceneIndexes: scenes,
  });
  const metrics = [];
  for (const scene of rendered.scenes) {
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${String(scene.index).padStart(2, "0")}.gif`));
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    metrics.push({
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
  }
  return {
    label: candidate.label,
    transform: candidate,
    averageSimilarity: Number(average(metrics.map((item) => item.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...metrics.map((item) => item.similarity)).toFixed(2)),
    metrics,
  };
}

async function prepareSource(candidate) {
  let image = sharp(sourceBuffer).rotate();
  if (candidate.rotate) {
    image = image.rotate(candidate.rotate, { background: "#ffffff" });
  }
  const width = Math.round(1536 * (candidate.scaleX ?? 1));
  const height = Math.round(1024 * (candidate.scaleY ?? 1));
  image = image.resize({ width, height, fit: "fill", kernel: "lanczos3" });

  const left = Math.round((1536 - width) / 2 + (candidate.offsetX ?? 0));
  const top = Math.round((1024 - height) / 2 + (candidate.offsetY ?? 0));
  return sharp({
    create: {
      width: 1536,
      height: 1024,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: await image.png().toBuffer(), left, top }])
    .png()
    .toBuffer();
}

function createCandidates() {
  const output = [{ label: "baseline" }];
  for (const scaleX of [0.9, 0.95, 1, 1.05, 1.1]) {
    for (const scaleY of [0.9, 0.95, 1, 1.05, 1.1]) {
      for (const offsetX of [-160, -80, 0, 80, 160]) {
        for (const offsetY of [-120, -60, 0, 60, 120]) {
          if (scaleX === 1 && scaleY === 1 && offsetX === 0 && offsetY === 0) {
            continue;
          }
          output.push({
            label: `sx${scaleX}-sy${scaleY}-x${offsetX}-y${offsetY}`,
            scaleX,
            scaleY,
            offsetX,
            offsetY,
          });
        }
      }
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
    if (value === "--source") {
      parsed.source = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-dir") {
      parsed.referenceDir = values[index + 1] || "";
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
