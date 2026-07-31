import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = path.resolve("D:/ozon/商品图/桌布/原图/TM20251026002593.png");
const referenceDir = path.resolve("D:/ozon/商品图/桌布/套图/TM20251026002593/images");
const outputDir = path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-focused-experiments");
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuFocused=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const candidates = [
  ["baseline", () => {}],
  ["remove-second-replace", (template) => removeDuplicateReplacements(template, "keep-first")],
  ["remove-first-replace", (template) => removeDuplicateReplacements(template, "keep-last")],
  ["occluder-top", moveNormalImageBetweenDuplicateReplacesAfterReplaces],
  ["remove-second-light-050", (template) => {
    removeDuplicateReplacements(template, "keep-first");
    template.linearLightStrength = 0.5;
  }],
  ["remove-second-light-080", (template) => {
    removeDuplicateReplacements(template, "keep-first");
    template.linearLightStrength = 0.8;
  }],
  ["occluder-top-light-050", (template) => {
    moveNormalImageBetweenDuplicateReplacesAfterReplaces(template);
    template.linearLightStrength = 0.5;
  }],
];

const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const summaries = [];
const compareRows = [];

for (const [name, mutate] of candidates) {
  const targetDir = path.join(templateRoot, name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  mutate(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(name);

  const rendered = await renderMockupsWithTemplate({ templateDir: name, sourceBuffer, sku });
  const metrics = [];
  const scenePanels = [];
  for (const scene of rendered.scenes) {
    const cloudPath = path.join(outputDir, `${name}-cloud-${String(scene.index).padStart(2, "0")}.png`);
    await fs.writeFile(cloudPath, scene.buffer);
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${String(scene.index).padStart(2, "0")}.gif`));
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    metrics.push({
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
    if (scene.index <= 8) {
      scenePanels.push(await labelPanel(sharp, scene.buffer, `${name} S${scene.index}`));
    }
  }
  summaries.push({
    name,
    average: Number(average(metrics.map((item) => item.similarity)).toFixed(2)),
    averageFirstEight: Number(average(metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    worstFirstEight: Number(Math.min(...metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    metrics,
  });
  compareRows.push(await rowPanel(sharp, scenePanels));
  console.log(JSON.stringify(summaries[summaries.length - 1]));
}

summaries.sort((left, right) => right.averageFirstEight - left.averageFirstEight);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
await sharp({
  create: {
    width: 8 * 210 + 7 * 8,
    height: compareRows.length * 304 + (compareRows.length - 1) * 10,
    channels: 3,
    background: "#ffffff",
  },
})
  .composite(compareRows.map((input, index) => ({ input, left: 0, top: index * 314 })))
  .jpeg({ quality: 90 })
  .toFile(path.join(outputDir, "candidate-scenes.jpg"));

console.table(summaries.map((item) => ({
  name: item.name,
  average: item.average,
  firstEight: item.averageFirstEight,
  worstFirstEight: item.worstFirstEight,
})));
console.log(path.join(outputDir, "candidate-scenes.jpg"));

function removeDuplicateReplacements(template, keep = "keep-first") {
  for (const scene of template.scenes) {
    const groups = new Map();
    for (const layer of scene.layers) {
      if (layer.kind !== "replace") continue;
      const key = replacementLayerKey(layer);
      const group = groups.get(key) ?? [];
      group.push(layer);
      groups.set(key, group);
    }
    const keepLayers = new Set();
    for (const group of groups.values()) {
      keepLayers.add(keep === "keep-last" ? group[group.length - 1] : group[0]);
    }
    scene.layers = scene.layers.filter((layer) => layer.kind !== "replace" || keepLayers.has(layer));
    normalizeOrder(scene.layers);
  }
}

function moveNormalImageBetweenDuplicateReplacesAfterReplaces(template) {
  for (const scene of template.scenes) {
    const layers = [...scene.layers];
    const replaceIndexesByKey = new Map();
    layers.forEach((layer, index) => {
      if (layer.kind !== "replace") return;
      const key = replacementLayerKey(layer);
      const current = replaceIndexesByKey.get(key) ?? [];
      current.push(index);
      replaceIndexesByKey.set(key, current);
    });
    for (const indexes of replaceIndexesByKey.values()) {
      if (indexes.length < 2) continue;
      const first = indexes[0];
      const last = indexes[indexes.length - 1];
      for (const layer of layers) {
        if (layer.kind === "image" && layer.blendMode === "normal" && layer.order > layers[first].order && layer.order < layers[last].order) {
          layer.order = layers[last].order + 0.1;
        }
      }
    }
    scene.layers = layers.sort((left, right) => left.order - right.order);
    normalizeOrder(scene.layers);
  }
}

function replacementLayerKey(layer) {
  return JSON.stringify({
    transform: layer.transform || null,
    clipMask: layer.clipMask || layer.mask || "",
  });
}

function normalizeOrder(layers) {
  layers
    .sort((left, right) => left.order - right.order)
    .forEach((layer, index) => {
      layer.order = index;
    });
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

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer).resize({ width: 210, height: 280, fit: "fill" }).jpeg({ quality: 86 }).toBuffer();
  const labelSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="210" height="24"><rect width="210" height="24" fill="#111827"/><text x="7" y="17" font-family="Arial" font-size="12" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 210, height: 304, channels: 3, background: "#fff" } })
    .composite([{ input: labelSvg, left: 0, top: 0 }, { input: image, left: 0, top: 24 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function rowPanel(sharp, panels) {
  return sharp({
    create: {
      width: panels.length * 210 + (panels.length - 1) * 8,
      height: 304,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({ input, left: index * 218, top: 0 })))
    .jpeg({ quality: 90 })
    .toBuffer();
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}
