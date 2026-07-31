import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-extra-layers-batch"));
const templateRoot = path.join(outputDir, "templates");
const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

const sceneIndexes = (args.scenes || "1,5")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const nameFilters = (args.nameContains || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
const opacityFilters = (args.opacities || "")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));

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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuExtraLayersBatch=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await collectSamples(sourceDir, referenceRoot);
if (!samples.length) {
  throw new Error("没有找到可用的桌布样机样本");
}

const candidates = buildCandidates()
  .filter((candidate) => !nameFilters.length || nameFilters.some((filter) => candidate.name.includes(filter)))
  .filter((candidate) => !opacityFilters.length || candidate.meta.opacity === undefined || opacityFilters.includes(candidate.meta.opacity));
const summaries = [];

for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await mirrorTemplateAssets(baseDir, targetDir);
  const template = structuredClone(baseTemplate);
  candidate.mutate(template);
  normalizeSceneOrders(template, candidate.scene);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rows = [];
  for (const sample of samples) {
    const rendered = await renderMockupsWithTemplate({
      templateDir: candidate.name,
      sourceBuffer: await fs.readFile(sample.sourcePath),
      sku: sample.sku,
      sceneIndexes: [candidate.scene],
    });
    const scene = rendered.scenes[0];
    if (args.keepImages === "true") {
      await fs.writeFile(path.join(outputDir, `${candidate.name}-${sample.sku}-cloud-${String(candidate.scene).padStart(2, "0")}.png`), scene.buffer);
    }
    const referenceBuffer = await fs.readFile(sample.refs[candidate.scene]);
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    rows.push({
      sku: sample.sku,
      scene: candidate.scene,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
  }

  const summary = {
    name: candidate.name,
    scene: candidate.scene,
    meta: candidate.meta,
    averageSimilarity: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
    rows,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    scene: summary.scene,
    name: summary.name,
    averageSimilarity: summary.averageSimilarity,
    worstSimilarity: summary.worstSimilarity,
    meta: summary.meta,
  }));
}

summaries.sort((left, right) => (
  right.averageSimilarity - left.averageSimilarity
  || right.worstSimilarity - left.worstSimilarity
));
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.slice(0, 40).map((item) => ({
  scene: item.scene,
  name: item.name,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
  ...item.meta,
})));
console.log(path.join(outputDir, "summary.json"));

function buildCandidates() {
  const output = [];
  for (const sceneIndex of sceneIndexes) {
    output.push({ scene: sceneIndex, name: `scene${sceneIndex}-baseline`, meta: { mode: "baseline" }, mutate: () => {} });
    const sceneId = String(sceneIndex).padStart(2, "0");
    const layerSets = [
      { label: "l0", layers: [imageLayer(`layers/scene-${sceneId}-layer-000.png`, `scene${sceneIndex}-shape-light`)] },
      { label: "l4", layers: [imageLayer(`layers/scene-${sceneId}-layer-004.png`, `scene${sceneIndex}-white-folds`)] },
      { label: "l2", layers: [imageLayer(`layers/scene-${sceneId}-layer-002.png`, `scene${sceneIndex}-front-drop`)] },
      {
        label: "l0-l2",
        layers: [
          imageLayer(`layers/scene-${sceneId}-layer-000.png`, `scene${sceneIndex}-shape-light`),
          imageLayer(`layers/scene-${sceneId}-layer-002.png`, `scene${sceneIndex}-front-drop`),
        ],
      },
      {
        label: "l4-l2",
        layers: [
          imageLayer(`layers/scene-${sceneId}-layer-004.png`, `scene${sceneIndex}-white-folds`),
          imageLayer(`layers/scene-${sceneId}-layer-002.png`, `scene${sceneIndex}-front-drop`),
        ],
      },
    ];
    const placements = [
      { label: "after-replace", orderBase: 1.5 },
      { label: "after-light", orderBase: 99 },
    ];
    const blends = ["normal", "multiply", "screen", "overlay", "soft_light", "lighten", "darken"];
    const opacities = [0.1, 0.2, 0.35, 0.5, 0.75, 1];
    for (const layerSet of layerSets) {
      for (const placement of placements) {
        for (const blendMode of blends) {
          for (const opacity of opacities) {
            output.push({
              scene: sceneIndex,
              name: `scene${sceneIndex}-${layerSet.label}-${placement.label}-${blendMode}-o${slugNumber(opacity)}`,
              meta: { layers: layerSet.label, placement: placement.label, blendMode, opacity },
              mutate: (template) => {
                const targetScene = findScene(template, sceneIndex);
                const maxOrder = Math.max(...targetScene.layers.map((layer) => layer.order));
                const orderBase = placement.orderBase === 99 ? maxOrder + 0.5 : placement.orderBase;
                targetScene.layers.push(...layerSet.layers.map((layer, index) => ({
                  ...layer,
                  order: orderBase + index / 10,
                  opacity,
                  blendMode,
                })));
              },
            });
          }
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

function findScene(template, sceneIndex) {
  const scene = template.scenes.find((item) => item.index === sceneIndex);
  if (!scene) {
    throw new Error(`scene ${sceneIndex} not found`);
  }
  return scene;
}

function normalizeSceneOrders(template, sceneIndex) {
  findScene(template, sceneIndex).layers.sort((left, right) => left.order - right.order).forEach((layer, index) => {
    layer.order = index;
  });
}

async function mirrorTemplateAssets(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.name === "template.json") {
      continue;
    }
    if (entry.isDirectory()) {
      await mirrorTemplateAssets(sourcePath, targetPath);
    } else if (entry.isFile()) {
      try {
        await fs.link(sourcePath, targetPath);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          await fs.copyFile(sourcePath, targetPath);
        }
      }
    }
  }
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
    } else if (value === "--scenes") {
      parsed.scenes = values[index + 1] || "";
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
