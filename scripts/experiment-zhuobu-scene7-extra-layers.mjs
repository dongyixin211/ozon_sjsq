import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene7-extra-layers"));
const templateRoot = path.join(outputDir, "templates");
const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
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

const baseTemplate = JSON.parse(await fs.readFile(path.join(baseDir, "template.json"), "utf8"));
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuScene7ExtraLayers=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await collectSamples(sourceDir, referenceRoot);
if (!samples.length) {
  throw new Error("没有找到可用于 scene 7 图层实验的桌布样本");
}

const nameFilters = (args.nameContains || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const opacityFilters = (args.opacities || "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));
const candidates = buildCandidates()
  .filter((candidate) => !nameFilters.length || nameFilters.some((filter) => candidate.name.includes(filter)))
  .filter((candidate) => !opacityFilters.length || candidate.meta.opacity === undefined || opacityFilters.includes(candidate.meta.opacity));
const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  candidate.mutate(template);
  normalizeScene7Orders(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rows = [];
  for (const sample of samples) {
    const sourceBuffer = await fs.readFile(sample.sourcePath);
    const rendered = await renderMockupsWithTemplate({
      templateDir: candidate.name,
      sourceBuffer,
      sku: sample.sku,
      sceneIndexes: [7],
    });
    const scene = rendered.scenes[0];
    if (args.keepImages === "true") {
      await fs.writeFile(path.join(outputDir, `${candidate.name}-${sample.sku}-cloud-07.png`), scene.buffer);
    }
    const referenceBuffer = await fs.readFile(sample.refs[7]);
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
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
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.slice(0, 30).map((item) => ({
  name: item.name,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
  ...item.meta,
})));
console.log(path.join(outputDir, "summary.json"));

function buildCandidates() {
  const output = [{ name: "baseline", meta: {}, mutate: () => {} }];
  const layerSets = [
    { label: "l4", layers: [imageLayer("layers/scene-07-layer-004.png", "scene7-front-full")] },
    { label: "l2", layers: [imageLayer("layers/scene-07-layer-002.png", "scene7-front-center")] },
    { label: "l4-l2", layers: [imageLayer("layers/scene-07-layer-004.png", "scene7-front-full"), imageLayer("layers/scene-07-layer-002.png", "scene7-front-center")] },
  ];
  const placements = [
    { label: "after-replace", orderBase: 1.5 },
    { label: "after-light", orderBase: 2.5 },
  ];
  const blends = ["normal", "multiply", "screen", "overlay", "soft_light", "lighten", "darken"];
  const opacities = [0.25, 0.5, 0.75, 1];
  for (const layerSet of layerSets) {
    for (const placement of placements) {
      for (const blendMode of blends) {
        for (const opacity of opacities) {
          output.push({
            name: `${layerSet.label}-${placement.label}-${blendMode}-o${slugNumber(opacity)}`,
            meta: { layers: layerSet.label, placement: placement.label, blendMode, opacity },
            mutate: (template) => {
              const targetScene = scene7(template);
              const additions = layerSet.layers.map((layer, index) => ({
                ...layer,
                order: placement.orderBase + index / 10,
                opacity,
                blendMode,
              }));
              targetScene.layers.push(...additions);
            },
          });
        }
      }
    }
  }
  return output;
}

function imageLayer(file, name) {
  return {
    name,
    left: 0,
    top: 0,
    width: 800,
    height: 1067,
    opacity: 1,
    kind: "image",
    blendMode: "normal",
    file,
  };
}

function scene7(template) {
  const targetScene = template.scenes.find((scene) => scene.index === 7);
  if (!targetScene) throw new Error("scene 7 not found");
  return targetScene;
}

function normalizeScene7Orders(template) {
  scene7(template).layers.sort((left, right) => left.order - right.order).forEach((layer, index) => {
    layer.order = index;
  });
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

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
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
    } else if (value === "--name-contains") {
      parsed.nameContains = values[index + 1] || "";
      index += 1;
    } else if (value === "--opacities") {
      parsed.opacities = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
