import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = path.resolve("D:/ozon/商品图/桌布/原图/TM20251026002593.png");
const referenceDir = path.resolve("D:/ozon/商品图/桌布/套图/TM20251026002593/images");
const outputDir = path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-mesh-vs-transform");
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuMeshVsTransform=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const candidates = [
  ["baseline-mesh", () => {}],
  ["plain-transform", (template) => {
    for (const scene of template.scenes) {
      for (const layer of scene.layers) {
        if (layer.kind === "replace") {
          delete layer.perspectiveMesh;
        }
      }
    }
  }],
  ["plain-transform-no-duplicates", (template) => {
    removeDuplicateReplacements(template);
    for (const scene of template.scenes) {
      for (const layer of scene.layers) {
        if (layer.kind === "replace") {
          delete layer.perspectiveMesh;
        }
      }
    }
  }],
  ["mesh-no-duplicates", (template) => {
    removeDuplicateReplacements(template);
  }],
  ["transform-under-mesh", (template) => {
    for (const scene of template.scenes) {
      const groups = groupDuplicateReplacements(scene);
      for (const group of groups) {
        if (group.length < 2) {
          continue;
        }
        delete group[0].perspectiveMesh;
        group[0].interpolation = "bicubic-soft";
        group[0].edgeFeather = 0.6;
      }
    }
  }],
  ["transform-under-mesh-no-occluder", (template) => {
    for (const scene of template.scenes) {
      const groups = groupDuplicateReplacements(scene);
      const fallbackLayers = new Set();
      for (const group of groups) {
        if (group.length < 2) {
          continue;
        }
        delete group[0].perspectiveMesh;
        group[0].interpolation = "bicubic-soft";
        group[0].edgeFeather = 0.6;
        fallbackLayers.add(group[0]);
      }
      for (const layer of scene.layers) {
        if (layer.kind === "image" && layer.blendMode === "normal" && layer.order > 0 && layer.order < 4) {
          layer.opacity = 0.25;
        }
      }
    }
  }],
];

const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const rows = [];
const panels = [];

for (const [name, mutate] of candidates) {
  const targetDir = path.join(templateRoot, name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  mutate(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(name);

  const rendered = await renderMockupsWithTemplate({ templateDir: name, sourceBuffer, sku });
  const metrics = [];
  const candidatePanels = [];
  for (const scene of rendered.scenes) {
    await fs.writeFile(path.join(outputDir, `${name}-cloud-${String(scene.index).padStart(2, "0")}.png`), scene.buffer);
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${String(scene.index).padStart(2, "0")}.gif`));
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    metrics.push({
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
    if (scene.index <= 8) {
      candidatePanels.push(await labelPanel(sharp, scene.buffer, `${name} S${scene.index}`));
    }
  }
  rows.push({
    name,
    average: Number(average(metrics.map((item) => item.similarity)).toFixed(2)),
    firstEight: Number(average(metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    worstFirstEight: Number(Math.min(...metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    metrics,
  });
  panels.push(await rowPanel(sharp, candidatePanels));
}

await sharp({
  create: {
    width: 8 * 210 + 7 * 8,
    height: panels.length * 304 + (panels.length - 1) * 10,
    channels: 3,
    background: "#ffffff",
  },
})
  .composite(panels.map((input, index) => ({ input, left: 0, top: index * 314 })))
  .jpeg({ quality: 90 })
  .toFile(path.join(outputDir, "candidate-scenes.jpg"));

rows.sort((left, right) => right.firstEight - left.firstEight);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.table(rows.map((item) => ({
  name: item.name,
  average: item.average,
  firstEight: item.firstEight,
  worstFirstEight: item.worstFirstEight,
})));
console.log(path.join(outputDir, "candidate-scenes.jpg"));

function removeDuplicateReplacements(template) {
  for (const scene of template.scenes) {
    const seen = new Set();
    scene.layers = scene.layers.filter((layer) => {
      if (layer.kind !== "replace") {
        return true;
      }
      const key = JSON.stringify({
        transform: layer.transform || null,
        clipMask: layer.clipMask || "",
      });
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
    scene.layers.sort((left, right) => left.order - right.order).forEach((layer, index) => {
      layer.order = index;
    });
  }
}

function groupDuplicateReplacements(scene) {
  const groups = new Map();
  for (const layer of scene.layers) {
    if (layer.kind !== "replace") {
      continue;
    }
    const key = JSON.stringify({
      transform: layer.transform || null,
      clipMask: layer.clipMask || "",
    });
    const group = groups.get(key) ?? [];
    group.push(layer);
    groups.set(key, group);
  }
  return [...groups.values()];
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
  const image = await sharp(buffer, { animated: false }).resize({ width: 210, height: 280, fit: "fill" }).jpeg({ quality: 86 }).toBuffer();
  const labelSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="210" height="24"><rect width="210" height="24" fill="#111827"/><text x="7" y="17" font-family="Arial" font-size="12" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 210, height: 304, channels: 3, background: "#fff" } })
    .composite([{ input: labelSvg, left: 0, top: 0 }, { input: image, left: 0, top: 24 }])
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function rowPanel(sharp, rowPanels) {
  return sharp({
    create: {
      width: rowPanels.length * 210 + (rowPanels.length - 1) * 8,
      height: 304,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(rowPanels.map((input, index) => ({ input, left: index * 218, top: 0 })))
    .jpeg({ quality: 90 })
    .toBuffer();
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
