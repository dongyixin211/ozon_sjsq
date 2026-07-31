import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-small-occluders"));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?smallOccluders=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const sku = path.basename(sourcePath, path.extname(sourcePath));

const smallLayerNames = new Map([
  [1, "图层 13"],
  [2, "图层 3"],
  [3, "图层 4"],
  [4, "图层 5"],
  [5, "图层 14"],
  [8, "图层 12"],
]);

const candidates = [
  { name: "baseline", scenes: [] },
  ...[...smallLayerNames.keys()].map((scene) => ({ name: `remove-scene-${scene}`, scenes: [scene] })),
  { name: "remove-1-2-4-5-8", scenes: [1, 2, 4, 5, 8] },
  { name: "remove-all-small", scenes: [...smallLayerNames.keys()] },
];

const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  for (const sceneIndex of candidate.scenes) {
    removeNamedSmallLayer(template, sceneIndex);
  }
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const sceneIndexes = candidate.name === "baseline" ? [...smallLayerNames.keys()] : [...new Set(candidate.scenes)];
  const rendered = await renderMockupsWithTemplate({ templateDir: candidate.name, sourceBuffer, sku, sceneIndexes });
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
await createComparison(sharp, summaries, referenceDir, outputDir, sku);

console.table(summaries.map((item) => ({
  name: item.name,
  average: item.average,
  metrics: item.metrics.map((metric) => `${metric.scene}:${metric.similarity}`).join(" "),
})));
console.log(path.join(outputDir, "summary.json"));
console.log(path.join(outputDir, "small-occluders-compare.jpg"));

function removeNamedSmallLayer(template, sceneIndex) {
  const scene = template.scenes.find((item) => item.index === sceneIndex);
  const name = smallLayerNames.get(sceneIndex);
  if (!scene || !name) {
    throw new Error(`scene/name not found: ${sceneIndex}`);
  }
  const before = scene.layers.length;
  scene.layers = scene.layers.filter((layer) => layer.name !== name);
  if (scene.layers.length !== before - 1) {
    throw new Error(`expected to remove ${name} from scene ${sceneIndex}`);
  }
  scene.layers.sort((left, right) => left.order - right.order).forEach((layer, index) => {
    layer.order = index;
  });
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

async function createComparison(sharp, summaries, referenceDir, outputDir, sku) {
  const rows = [];
  for (const sceneIndex of smallLayerNames.keys()) {
    const sceneId = String(sceneIndex).padStart(2, "0");
    const panels = [await labelPanel(sharp, await fs.readFile(path.join(referenceDir, `111_${sku}_${sceneId}.gif`)), `PS ${sceneIndex}`)];
    const baseline = summaries.find((item) => item.name === "baseline")?.metrics.find((item) => item.scene === sceneIndex);
    if (baseline) {
      panels.push(await labelPanel(sharp, await fs.readFile(baseline.cloudPath), `baseline ${baseline.similarity}%`));
    }
    for (const summary of summaries.filter((item) => item.scenes.includes(sceneIndex))) {
      const metric = summary.metrics.find((item) => item.scene === sceneIndex);
      if (!metric) continue;
      panels.push(await labelPanel(sharp, await fs.readFile(metric.cloudPath), `${summary.name} ${metric.similarity}%`));
    }
    rows.push(await rowPanel(sharp, panels));
  }
  await sharp({
    create: {
      width: 280 * 4 + 12 * 3,
      height: rows.length * 418 + (rows.length - 1) * 14,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(rows.map((input, index) => ({ input, left: 0, top: index * 432 })))
    .jpeg({ quality: 90 })
    .toFile(path.join(outputDir, "small-occluders-compare.jpg"));
}

async function rowPanel(sharp, panels) {
  const visiblePanels = panels.slice(0, 4);
  return sharp({
    create: {
      width: 280 * 4 + 12 * 3,
      height: 418,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(visiblePanels.map((input, index) => ({ input, left: index * 292, top: 0 })))
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false }).resize({ width: 280, height: 374, fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="280" height="44"><rect width="280" height="44" fill="#111827"/><text x="8" y="28" font-family="Arial" font-size="14" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 280, height: 418, channels: 3, background: "#fff" } })
    .composite([{ input: svg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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
