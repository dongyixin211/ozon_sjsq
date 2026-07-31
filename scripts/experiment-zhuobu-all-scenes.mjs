import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceDir = path.resolve("D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve("D:/ozon/商品图/桌布/套图");
const outputDir = path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-all-scene-experiments");
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuAllScenes=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const candidates = [
  {
    name: "baseline",
    mutate: () => {},
  },
  {
    name: "no-duplicate-replace",
    mutate: (template) => removeDuplicateReplacements(template),
  },
  {
    name: "occluder-after-duplicate",
    mutate: (template) => moveNormalImageBetweenDuplicateReplacesAfterReplaces(template),
  },
  {
    name: "no-duplicate-strong-light",
    mutate: (template) => {
      removeDuplicateReplacements(template);
      template.linearLightStrength = 0.42;
    },
  },
  {
    name: "no-duplicate-light-055",
    mutate: (template) => {
      removeDuplicateReplacements(template);
      template.linearLightStrength = 0.55;
    },
  },
  {
    name: "no-duplicate-light-070",
    mutate: (template) => {
      removeDuplicateReplacements(template);
      template.linearLightStrength = 0.7;
    },
  },
  {
    name: "no-duplicate-edge-bilinear",
    mutate: (template) => {
      removeDuplicateReplacements(template);
      setReplaceOptions(template, { sampleMode: "edge", interpolation: "bilinear" });
    },
  },
  {
    name: "no-duplicate-center-bicubic-ps",
    mutate: (template) => {
      removeDuplicateReplacements(template);
      setReplaceOptions(template, { sampleMode: "center", interpolation: "bicubic-ps" });
    },
  },
  {
    name: "no-duplicate-supersample5",
    mutate: (template) => {
      removeDuplicateReplacements(template);
      setReplaceOptions(template, { sampleMode: "center", interpolation: "supersample5" });
    },
  },
  {
    name: "no-duplicate-offset-zero",
    mutate: (template) => {
      removeDuplicateReplacements(template);
      setReplaceOptions(template, { pixelOffsetX: 0, pixelOffsetY: 0 });
    },
  },
  {
    name: "no-duplicate-offset-half",
    mutate: (template) => {
      removeDuplicateReplacements(template);
      setReplaceOptions(template, { pixelOffsetX: -0.5, pixelOffsetY: -0.5 });
    },
  },
  {
    name: "no-duplicate-scene-light-tuned",
    mutate: (template) => {
      removeDuplicateReplacements(template);
      for (const scene of template.scenes) {
        if (scene.index >= 1 && scene.index <= 8) {
          scene.linearLightStrength = 0.5;
        }
      }
    },
  },
];

const sourceFiles = (await fs.readdir(sourceDir))
  .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
  .sort();

const summaries = [];
for (const candidate of candidates) {
  const slug = candidate.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const targetDir = path.join(templateRoot, slug);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  candidate.mutate(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(slug);

  const rows = [];
  for (const file of sourceFiles) {
    const sku = path.basename(file, path.extname(file));
    const refs = await completeReferenceFiles(path.join(referenceRoot, sku, "images"), sku);
    if (!refs) {
      continue;
    }
    const sourceBuffer = await fs.readFile(path.join(sourceDir, file));
    const rendered = await renderMockupsWithTemplate({ templateDir: slug, sourceBuffer, sku });
    for (const scene of rendered.scenes) {
      const referenceBuffer = await fs.readFile(refs[scene.index]);
      const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
      rows.push({
        sku,
        scene: scene.index,
        mae: Number(mae.toFixed(3)),
        similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
      });
    }
  }

  const firstEight = rows.filter((row) => row.scene <= 8);
  const byScene = sceneSummary(firstEight);
  const summary = {
    name: candidate.name,
    averageSimilarity: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
    averageSimilarityFirstEight: Number(average(firstEight.map((row) => row.similarity)).toFixed(2)),
    worstSimilarityFirstEight: Number(Math.min(...firstEight.map((row) => row.similarity)).toFixed(2)),
    sceneSummary: byScene,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.averageSimilarity,
    firstEight: summary.averageSimilarityFirstEight,
    worstFirstEight: summary.worstSimilarityFirstEight,
  }));
}

summaries.sort((left, right) => right.averageSimilarityFirstEight - left.averageSimilarityFirstEight);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
console.table(summaries.map((item) => ({
  name: item.name,
  average: item.averageSimilarity,
  firstEight: item.averageSimilarityFirstEight,
  worstFirstEight: item.worstSimilarityFirstEight,
})));

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

function removeDuplicateReplacements(template) {
  for (const scene of template.scenes) {
    const seen = new Set();
    scene.layers = scene.layers.filter((layer) => {
      if (layer.kind !== "replace") {
        return true;
      }
      const key = replacementLayerKey(layer);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
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

function setReplaceOptions(template, options) {
  for (const scene of template.scenes) {
    for (const layer of scene.layers) {
      if (layer.kind !== "replace") {
        continue;
      }
      for (const [key, value] of Object.entries(options)) {
        layer[key] = value;
      }
    }
  }
}

function normalizeOrder(layers) {
  layers
    .sort((left, right) => left.order - right.order)
    .forEach((layer, index) => {
      layer.order = index;
    });
}

function sceneSummary(rows) {
  const byScene = new Map();
  for (const row of rows) {
    const items = byScene.get(row.scene) ?? [];
    items.push(row);
    byScene.set(row.scene, items);
  }
  return [...byScene.entries()].sort(([left], [right]) => left - right).map(([scene, items]) => ({
    scene,
    averageSimilarity: Number(average(items.map((item) => item.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...items.map((item) => item.similarity)).toFixed(2)),
  }));
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
