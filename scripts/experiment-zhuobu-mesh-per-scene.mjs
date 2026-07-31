import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-mesh-per-scene"));
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

const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const baseTemplate = JSON.parse(await fs.readFile(path.join(baseDir, "template.json"), "utf8"));
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?meshPerScene=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const sku = path.basename(sourcePath, path.extname(sourcePath));

const sceneIndexes = baseTemplate.scenes
  .filter((scene) => scene.layers.some((layer) => layer.kind === "replace" && layer.perspectiveMesh))
  .map((scene) => scene.index);

const candidates = [
  { name: "baseline", scenes: [] },
  ...sceneIndexes.map((sceneIndex) => ({ name: `plain-scene-${sceneIndex}`, scenes: [sceneIndex] })),
  { name: "plain-all-mesh-scenes", scenes: sceneIndexes },
];

const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  for (const sceneIndex of candidate.scenes) {
    deleteSceneMeshes(template, sceneIndex);
  }
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const renderScenes = candidate.name === "baseline" ? sceneIndexes : candidate.scenes;
  const rendered = await renderMockupsWithTemplate({ templateDir: candidate.name, sourceBuffer, sku, sceneIndexes: renderScenes });
  const metrics = [];
  for (const scene of rendered.scenes) {
    const sceneId = String(scene.index).padStart(2, "0");
    const cloudPath = path.join(outputDir, `${candidate.name}-cloud-${sceneId}.png`);
    await fs.writeFile(cloudPath, scene.buffer);
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${sceneId}.gif`));
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    metrics.push({
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
      cloudPath,
    });
  }
  const summary = {
    name: candidate.name,
    scenes: candidate.scenes,
    average: Number(average(metrics.map((item) => item.similarity)).toFixed(2)),
    metrics,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.average,
    metrics: summary.metrics.map((item) => `${item.scene}:${item.similarity}`).join(", "),
  }));
}

await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
console.table(summaries.map((item) => ({
  name: item.name,
  average: item.average,
  metrics: item.metrics.map((metric) => `${metric.scene}:${metric.similarity}`).join(" "),
})));
console.log(path.join(outputDir, "summary.json"));

function deleteSceneMeshes(template, sceneIndex) {
  const scene = template.scenes.find((item) => item.index === sceneIndex);
  if (!scene) throw new Error(`scene not found: ${sceneIndex}`);
  for (const layer of scene.layers) {
    if (layer.kind === "replace") {
      delete layer.perspectiveMesh;
    }
  }
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

async function rawRgb(sharp, buffer) {
  return sharp(buffer, { animated: false })
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
    if (value === "--source") {
      parsed.source = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-dir") {
      parsed.referenceDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
