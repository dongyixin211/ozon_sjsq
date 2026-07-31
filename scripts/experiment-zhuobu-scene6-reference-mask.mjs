import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene6-reference-mask"));
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
const oldTemplatePath = path.join(repoRoot, ".codex-work", "zhuobu-mask-candidate-check-alpha", "templates", "exported-mask-red", "template.json");
const baseTemplate = JSON.parse(await fs.readFile(path.join(baseDir, "template.json"), "utf8"));
const oldTemplate = JSON.parse(await fs.readFile(oldTemplatePath, "utf8"));
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?scene6ReferenceMask=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_06.gif`));
const referenceMask = await buildReferenceMask(sharp, referenceBuffer, Number(args.threshold || 18));
await fs.writeFile(path.join(outputDir, "scene-06-reference-mask.png"), referenceMask);

const candidates = [
  ["baseline", () => {}],
  ["reference-mask", (template) => applyReferenceMask(template)],
  ["reference-mask-no-duplicates", (template) => {
    applyReferenceMask(template);
    keepTopScene6ReplaceInEachPair(template);
  }],
  ["reference-mask-mesh", (template) => {
    applyReferenceMask(template);
    restoreScene6Meshes(template);
  }],
  ["reference-mask-mesh-no-duplicates", (template) => {
    applyReferenceMask(template);
    restoreScene6Meshes(template);
    keepTopScene6ReplaceInEachPair(template);
  }],
  ["reference-mask-transform-only", (template) => {
    applyReferenceMask(template);
    removeScene6Meshes(template);
  }],
  ["reference-mask-transform-only-no-duplicates", (template) => {
    applyReferenceMask(template);
    removeScene6Meshes(template);
    keepTopScene6ReplaceInEachPair(template);
  }],
];

const summaries = [];
for (const [name, mutate] of candidates) {
  const targetDir = path.join(templateRoot, name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  await fs.mkdir(path.join(targetDir, "masks"), { recursive: true });
  await fs.copyFile(path.join(outputDir, "scene-06-reference-mask.png"), path.join(targetDir, "masks", "scene-06-reference-mask.png"));
  const template = structuredClone(baseTemplate);
  mutate(template);
  normalizeScene6Orders(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(name);

  const rendered = await renderMockupsWithTemplate({ templateDir: name, sourceBuffer, sku, sceneIndexes: [6] });
  const cloudBuffer = rendered.scenes[0].buffer;
  const cloudPath = path.join(outputDir, `${name}-cloud-06.png`);
  await fs.writeFile(cloudPath, cloudBuffer);
  const metric = await calculateMae(sharp, referenceBuffer, cloudBuffer);
  const coverage = await calculateCoverage(sharp, referenceBuffer, cloudBuffer);
  const summary = { name, ...metric, ...coverage, cloudPath };
  summaries.push(summary);
  console.log(JSON.stringify(summary));
}

summaries.sort((left, right) => right.similarity - left.similarity);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
await createComparison(sharp, summaries, referenceBuffer, outputDir);

console.table(summaries.map((item) => ({
  name: item.name,
  similarity: item.similarity,
  mae: item.mae,
  missedPct: item.missedPct,
  extraPct: item.extraPct,
  cloudPatternPct: item.cloudPatternPct,
})));
console.log(path.join(outputDir, "summary.json"));
console.log(path.join(outputDir, "scene-06-reference-mask.jpg"));

async function buildReferenceMask(sharp, referenceBuffer, threshold) {
  const scene = scene6(baseTemplate);
  const baseLayer = scene.layers.find((layer) => (
    layer.kind === "image" && layer.blendMode === "normal" && layer.file === "layers/scene-06-layer-014.png"
  ));
  if (!baseLayer?.file) throw new Error("scene 6 base layer not found");
  const [reference, base] = await Promise.all([
    rawRgb(sharp, referenceBuffer),
    rawRgb(sharp, await fs.readFile(path.join(baseDir, baseLayer.file))),
  ]);
  const output = Buffer.alloc(reference.info.width * reference.info.height);
  for (let source = 0, target = 0; source < reference.data.length; source += 3, target += 1) {
    const diff = pixelDiff(reference.data, base.data, source);
    const patterned = diff > threshold && !isNearWhite(reference.data, source);
    output[target] = patterned ? 255 : 0;
  }
  const mask = await sharp(output, {
    raw: {
      width: reference.info.width,
      height: reference.info.height,
      channels: 1,
    },
  })
    .median(3)
    .blur(0.4)
    .png()
    .toBuffer();
  return mask;
}

function applyReferenceMask(template) {
  for (const layer of scene6(template).layers) {
    if (layer.kind !== "replace") continue;
    layer.mask = "masks/scene-06-reference-mask.png";
    layer.maskLeft = 0;
    layer.maskTop = 0;
    layer.maskWidth = 800;
    layer.maskHeight = 1067;
  }
}

function restoreScene6Meshes(template) {
  const meshByName = new Map(
    scene6(oldTemplate).layers
      .filter((layer) => layer.kind === "replace" && layer.perspectiveMesh)
      .map((layer) => [layer.name, layer.perspectiveMesh]),
  );
  for (const layer of scene6(template).layers) {
    if (layer.kind !== "replace") continue;
    const mesh = meshByName.get(layer.name);
    if (mesh) {
      layer.perspectiveMesh = structuredClone(mesh);
    }
  }
}

function removeScene6Meshes(template) {
  for (const layer of scene6(template).layers) {
    if (layer.kind === "replace") {
      delete layer.perspectiveMesh;
    }
  }
}

function keepTopScene6ReplaceInEachPair(template) {
  const keep = new Set([
    "桌布链接图 拷贝 17",
    "桌布链接图 拷贝 6",
    "桌布链接图 拷贝 15",
  ]);
  const scene = scene6(template);
  scene.layers = scene.layers.filter((layer) => layer.kind !== "replace" || keep.has(layer.name));
}

function scene6(template) {
  const scene = template.scenes.find((item) => item.index === 6);
  if (!scene) throw new Error("scene 6 not found");
  return scene;
}

function normalizeScene6Orders(template) {
  const scene = scene6(template);
  scene.layers.sort((left, right) => left.order - right.order).forEach((layer, index) => {
    layer.order = index;
  });
}

async function calculateMae(sharp, referenceBuffer, cloudBuffer) {
  const reference = await rawRgb(sharp, referenceBuffer);
  const cloud = await rawRgb(sharp, cloudBuffer);
  let sum = 0;
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    sum += pixelDiff(reference.data, cloud.data, offset);
  }
  const mae = sum / (reference.data.length / 3);
  return {
    mae: Number(mae.toFixed(3)),
    similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
  };
}

async function calculateCoverage(sharp, referenceBuffer, cloudBuffer) {
  const baseLayer = scene6(baseTemplate).layers.find((layer) => (
    layer.kind === "image" && layer.blendMode === "normal" && layer.file === "layers/scene-06-layer-014.png"
  ));
  const [reference, cloud, base] = await Promise.all([
    rawRgb(sharp, referenceBuffer),
    rawRgb(sharp, cloudBuffer),
    rawRgb(sharp, await fs.readFile(path.join(baseDir, baseLayer.file))),
  ]);
  let psPattern = 0;
  let cloudPattern = 0;
  let missed = 0;
  let extra = 0;
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    const psDiff = pixelDiff(reference.data, base.data, offset);
    const cloudDiff = pixelDiff(cloud.data, base.data, offset);
    const psIsPattern = psDiff > 26 && !isNearWhite(reference.data, offset);
    const cloudIsPattern = cloudDiff > 26 && !isNearWhite(cloud.data, offset);
    if (psIsPattern) psPattern += 1;
    if (cloudIsPattern) cloudPattern += 1;
    if (psIsPattern && !cloudIsPattern) missed += 1;
    if (!psIsPattern && cloudIsPattern) extra += 1;
  }
  const total = reference.info.width * reference.info.height;
  return {
    psPatternPct: pct(psPattern, total),
    cloudPatternPct: pct(cloudPattern, total),
    missedPct: pct(missed, total),
    extraPct: pct(extra, total),
  };
}

async function rawRgb(sharp, input) {
  return sharp(input, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
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

function isNearWhite(data, offset) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  return r > 225 && g > 225 && b > 225 && Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

function pct(value, total) {
  return Number(((value / total) * 100).toFixed(2));
}

async function createComparison(sharp, summaries, referenceBuffer, outputDir) {
  const panels = [await labelPanel(sharp, referenceBuffer, "PS")];
  for (const summary of summaries) {
    panels.push(await labelPanel(sharp, await fs.readFile(summary.cloudPath), `${summary.name} ${summary.similarity}%`));
  }
  await sharp({
    create: {
      width: panels.length * 240 + (panels.length - 1) * 10,
      height: 364,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({ input, left: index * 250, top: 0 })))
    .jpeg({ quality: 90 })
    .toFile(path.join(outputDir, "scene-06-reference-mask.jpg"));
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false })
    .resize({ width: 240, height: 320, fit: "fill" })
    .jpeg({ quality: 90 })
    .toBuffer();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="44"><rect width="240" height="44" fill="#111827"/><text x="8" y="28" font-family="Arial" font-size="13" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 240, height: 364, channels: 3, background: "#fff" } })
    .composite([{ input: svg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
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
    } else if (value === "--threshold") {
      parsed.threshold = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
