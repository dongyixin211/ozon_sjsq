import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-boost-mask"));
const templateRoot = path.join(outputDir, "templates");
const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;
const sceneIndexes = (args.scenes || "1,5")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isInteger(item) && item > 0);
const opacityValues = (args.opacities || "0.06,0.1,0.14,0.18,0.24,0.32")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item));
const maskFilters = new Set((args.masks || "")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean));
const colorModeValues = (args.colorModes || "inherit,none")
  .split(",")
  .map((item) => item.trim())
  .filter(Boolean);

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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuBoostMask=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await collectSamples(sourceDir, referenceRoot);
if (!samples.length) {
  throw new Error("No complete zhuobu samples found.");
}

const baselineTargetDir = path.join(templateRoot, "baseline-red");
await mirrorTemplateAssets(baseDir, baselineTargetDir);
await fs.writeFile(path.join(baselineTargetDir, "template.json"), `${JSON.stringify(baseTemplate, null, 2)}\n`, "utf8");
invalidateMockupTemplateCache("baseline-red");

const baselineRows = [];
const sceneRaw = new Map();
for (const sceneIndex of sceneIndexes) {
  sceneRaw.set(sceneIndex, []);
}
for (const sample of samples) {
  const sourceBuffer = await fs.readFile(sample.sourcePath);
  const rendered = await renderMockupsWithTemplate({
    templateDir: "baseline-red",
    sourceBuffer,
    sku: sample.sku,
    sceneIndexes,
  });
  for (const scene of rendered.scenes) {
    const referenceBuffer = await fs.readFile(sample.refs[scene.index]);
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    baselineRows.push(row(sample.sku, scene.index, mae));
    sceneRaw.get(scene.index).push({
      sku: sample.sku,
      reference: await rawRgb(sharp, referenceBuffer),
      cloud: await rawRgb(sharp, scene.buffer),
      base: await rawRgb(sharp, path.join(baseDir, findBaseLayerFile(baseTemplate, scene.index))),
    });
  }
}

const masks = [];
for (const sceneIndex of sceneIndexes) {
  const items = sceneRaw.get(sceneIndex);
  const maskDefs = buildMasks(items);
  for (const def of maskDefs) {
    const relativePath = `masks/scene-${String(sceneIndex).padStart(2, "0")}-boost-${def.name}.png`;
    const outputPath = path.join(outputDir, relativePath);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await sharp(def.data, { raw: { width: 800, height: 1067, channels: 1 } })
      .blur(def.blur)
      .png()
      .toFile(outputPath);
    masks.push({ scene: sceneIndex, name: def.name, relativePath, sourcePath: outputPath });
  }
}

const candidates = [{ name: "baseline-red", scene: 0, meta: { mode: "baseline" }, mutate: () => {} }];
for (const mask of masks) {
  if (maskFilters.size && !maskFilters.has(mask.name)) {
    continue;
  }
  for (const opacity of opacityValues) {
    for (const colorMode of colorModeValues) {
      candidates.push({
        name: `scene${mask.scene}-${mask.name}-${colorMode}-o${slug(opacity)}`,
        scene: mask.scene,
        meta: { mode: "boost", scene: mask.scene, mask: mask.name, opacity, colorMode },
        mutate: async (template, targetDir) => {
          await fs.mkdir(path.join(targetDir, "masks"), { recursive: true });
          await fs.copyFile(mask.sourcePath, path.join(targetDir, mask.relativePath));
          const scene = findScene(template, mask.scene);
          const replace = scene.layers.find((layer) => layer.kind === "replace");
          if (!replace) {
            throw new Error(`No replace layer in scene ${mask.scene}`);
          }
          const boost = structuredClone(replace);
          boost.name = `${replace.name} boost ${mask.name}`;
          boost.order = replace.order + 0.1;
          boost.opacity = opacity;
          boost.mask = mask.relativePath;
          boost.edgeFeather = 0;
          if (colorMode === "none") {
            delete boost.colorCorrection;
          }
          scene.layers.push(boost);
          normalizeSceneOrders(scene);
        },
      });
    }
  }
}

const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  if (candidate.name !== "baseline-red") {
    await mirrorTemplateAssets(baseDir, targetDir);
    const template = structuredClone(baseTemplate);
    await candidate.mutate(template, targetDir);
    await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
    invalidateMockupTemplateCache(candidate.name);
  }
  const rows = candidate.name === "baseline-red"
    ? baselineRows
    : await renderCandidate(candidate.name, candidate.scene);
  const summary = summarize(candidate.name, candidate.meta, rows);
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.averageSimilarity,
    worst: summary.worstSimilarity,
    meta: summary.meta,
  }));
}

summaries.sort((left, right) => (
  right.averageSimilarity - left.averageSimilarity
  || right.worstSimilarity - left.worstSimilarity
));
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((item) => item.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.slice(0, 30).map((item) => ({
  name: item.name,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
  ...item.meta,
})));
console.log(path.join(outputDir, "summary.json"));

async function renderCandidate(templateDir, sceneIndex) {
  const rows = [];
  for (const sample of samples) {
    const rendered = await renderMockupsWithTemplate({
      templateDir,
      sourceBuffer: await fs.readFile(sample.sourcePath),
      sku: sample.sku,
      sceneIndexes: [sceneIndex],
    });
    const scene = rendered.scenes[0];
    const referenceBuffer = await fs.readFile(sample.refs[sceneIndex]);
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    rows.push(row(sample.sku, scene.index, mae));
  }
  return rows;
}

function buildMasks(items) {
  const pixelCount = 800 * 1067;
  const missed = Buffer.alloc(pixelCount);
  const soft = Buffer.alloc(pixelCount);
  const gap = Buffer.alloc(pixelCount);
  for (let pixel = 0, offset = 0; pixel < pixelCount; pixel += 1, offset += 3) {
    let missedCount = 0;
    let gapSum = 0;
    let strongPsCount = 0;
    for (const item of items) {
      const psDiff = pixelDiff(item.reference.data, item.base.data, offset);
      const cloudDiff = pixelDiff(item.cloud.data, item.base.data, offset);
      const valueGap = Math.max(0, psDiff - cloudDiff);
      if (psDiff > 24) {
        strongPsCount += 1;
      }
      if (psDiff > 26 && cloudDiff < 26 && !isNearWhite(item.reference.data, offset)) {
        missedCount += 1;
      }
      gapSum += valueGap;
    }
    const gapAverage = gapSum / Math.max(1, items.length);
    if (missedCount >= 2) {
      missed[pixel] = 255;
    }
    if (strongPsCount >= 2 && gapAverage > 4) {
      soft[pixel] = clampByte((gapAverage - 4) * 18);
    }
    if (gapAverage > 10) {
      gap[pixel] = clampByte((gapAverage - 10) * 14);
    }
  }
  return [
    { name: "missed", data: missed, blur: 0.6 },
    { name: "softgap", data: soft, blur: 0.8 },
    { name: "hardgap", data: gap, blur: 0.6 },
  ];
}

async function collectSamples(root, referenceRoot) {
  const files = (await fs.readdir(root)).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)).sort();
  const output = [];
  for (const file of files) {
    const sku = path.basename(file, path.extname(file));
    const refs = await completeReferenceFiles(referenceRoot, sku);
    if (refs) {
      output.push({ sku, sourcePath: path.join(root, file), refs });
    }
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

async function mirrorTemplateAssets(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === "template.json") {
      continue;
    }
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
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

function findBaseLayerFile(template, sceneIndex) {
  const scene = findScene(template, sceneIndex);
  const layer = scene.layers
    .filter((item) => item.kind === "image" && item.blendMode === "normal" && item.width === 800 && item.height === 1067)
    .sort((left, right) => left.order - right.order)[0];
  if (!layer?.file) {
    throw new Error(`No base layer for scene ${sceneIndex}`);
  }
  return layer.file;
}

function findScene(template, sceneIndex) {
  const scene = template.scenes.find((item) => item.index === sceneIndex);
  if (!scene) {
    throw new Error(`Scene not found: ${sceneIndex}`);
  }
  return scene;
}

function normalizeSceneOrders(scene) {
  scene.layers.sort((left, right) => left.order - right.order).forEach((layer, index) => {
    layer.order = index;
  });
}

function summarize(name, meta, rows) {
  return {
    name,
    meta,
    averageSimilarity: Number(average(rows.map((item) => item.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...rows.map((item) => item.similarity)).toFixed(2)),
    rows,
  };
}

function row(sku, scene, mae) {
  return {
    sku,
    scene,
    mae: Number(mae.toFixed(3)),
    similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
  };
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

function isNearWhite(data, offset) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  return r > 225 && g > 225 && b > 225 && Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function slug(value) {
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
    } else if (value === "--opacities") {
      parsed.opacities = values[index + 1] || "";
      index += 1;
    } else if (value === "--masks") {
      parsed.masks = values[index + 1] || "";
      index += 1;
    } else if (value === "--color-modes") {
      parsed.colorModes = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
