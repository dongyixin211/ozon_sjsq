import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-layer-color-correction-scan"));
const templateRoot = path.join(outputDir, "templates");
const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

const sceneIndexes = (args.scenes || "1,3,5,7")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const mode = args.mode || "strength";

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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuLayerColorCorrectionScan=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await collectSamples(sourceDir, referenceRoot);

if (!samples.length) {
  throw new Error("没有找到可用于桌布样机校正扫描的完整样本。");
}

const summaries = [];
for (const sceneIndex of sceneIndexes) {
  const scene = findScene(baseTemplate, sceneIndex);
  const baseCorrection = firstReplacementCorrection(scene);
  const candidates = buildCandidates(sceneIndex, baseCorrection, mode);

  for (const candidate of candidates) {
    const targetDir = path.join(templateRoot, candidate.name);
    await fs.cp(baseDir, targetDir, { recursive: true });
    const template = structuredClone(baseTemplate);
    candidate.mutate(template);
    await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
    invalidateMockupTemplateCache(candidate.name);

    const rows = [];
    for (const sample of samples) {
      const rendered = await renderMockupsWithTemplate({
        templateDir: candidate.name,
        sourceBuffer: await fs.readFile(sample.sourcePath),
        sku: sample.sku,
        sceneIndexes: [sceneIndex],
      });
      const renderedScene = rendered.scenes[0];
      if (args.keepImages === "true") {
        await fs.writeFile(path.join(outputDir, `${candidate.name}-${sample.sku}-cloud-${String(sceneIndex).padStart(2, "0")}.png`), renderedScene.buffer);
      }
      const referenceBuffer = await fs.readFile(sample.refs[sceneIndex]);
      const mae = await calculateMae(sharp, referenceBuffer, renderedScene.buffer);
      rows.push({
        sku: sample.sku,
        scene: sceneIndex,
        mae: Number(mae.toFixed(3)),
        similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
      });
    }

    const summary = summarize(candidate.name, sceneIndex, candidate.meta, rows);
    summaries.push(summary);
    console.log(JSON.stringify({
      scene: sceneIndex,
      name: summary.name,
      averageSimilarity: summary.averageSimilarity,
      worstSimilarity: summary.worstSimilarity,
      meta: summary.meta,
    }));
  }
}

summaries.sort((left, right) => (
  right.averageSimilarity - left.averageSimilarity
  || right.worstSimilarity - left.worstSimilarity
));

await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ mode, samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");

console.table(summaries.slice(0, 40).map((item) => ({
  scene: item.scene,
  name: item.name,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
  ...item.meta,
})));
console.log(path.join(outputDir, "summary.json"));

function buildCandidates(sceneIndex, baseCorrection, scanMode) {
  const output = [{
    name: `scene${sceneIndex}-baseline`,
    meta: { mode: "baseline" },
    mutate: () => {},
  }];

  if (scanMode === "identity" || scanMode === "all") {
    for (const scale of [0.94, 0.96, 0.98, 1, 1.02, 1.04]) {
      for (const offset of [-12, -8, -4, 0, 4, 8, 12]) {
        if (scale === 1 && offset === 0) continue;
        const correction = rgbCorrection(scale, offset, 1);
        output.push({
          name: `scene${sceneIndex}-rgb-s${slug(scale)}-o${slug(offset)}`,
          meta: { mode: "identity", scale, offset, strength: 1 },
          mutate: (template) => setSceneReplaceCorrection(template, sceneIndex, correction),
        });
      }
    }
  }

  if ((scanMode === "strength" || scanMode === "all") && baseCorrection) {
    for (const strength of [0, 0.2, 0.35, 0.5, 0.65, 0.75, 0.85, 1]) {
      output.push({
        name: `scene${sceneIndex}-current-strength-${slug(strength)}`,
        meta: { mode: "strength", strength },
        mutate: (template) => setSceneReplaceCorrection(template, sceneIndex, {
          ...structuredClone(baseCorrection),
          strength,
        }),
      });
    }
  }

  if ((scanMode === "scale" || scanMode === "all") && baseCorrection) {
    for (const multiplier of [0.85, 0.9, 0.95, 1, 1.05, 1.1, 1.15]) {
      output.push({
        name: `scene${sceneIndex}-current-scale-${slug(multiplier)}`,
        meta: { mode: "scale", multiplier },
        mutate: (template) => setSceneReplaceCorrection(template, sceneIndex, scaleCorrection(baseCorrection, multiplier)),
      });
    }
  }

  return output;
}

function rgbCorrection(scale, offset, strength) {
  return {
    red: { scale, offset },
    green: { scale, offset },
    blue: { scale, offset },
    strength,
  };
}

function scaleCorrection(correction, multiplier) {
  const scaled = structuredClone(correction);
  for (const channel of ["red", "green", "blue"]) {
    if (!scaled[channel]) continue;
    scaled[channel].scale = round4(1 + ((scaled[channel].scale ?? 1) - 1) * multiplier);
    scaled[channel].offset = round4((scaled[channel].offset ?? 0) * multiplier);
  }
  return scaled;
}

function setSceneReplaceCorrection(template, sceneIndex, correction) {
  const scene = findScene(template, sceneIndex);
  for (const layer of scene.layers) {
    if (layer.kind !== "replace") continue;
    if (!correction || correction.strength === 0) {
      delete layer.colorCorrection;
    } else {
      layer.colorCorrection = structuredClone(correction);
    }
  }
}

function firstReplacementCorrection(scene) {
  return scene.layers.find((layer) => layer.kind === "replace" && layer.colorCorrection)?.colorCorrection;
}

function findScene(template, sceneIndex) {
  const scene = template.scenes.find((item) => item.index === sceneIndex);
  if (!scene) {
    throw new Error(`未找到 scene ${sceneIndex}`);
  }
  return scene;
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

function summarize(name, scene, meta, rows) {
  return {
    name,
    scene,
    meta,
    averageSimilarity: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
    rows,
  };
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

async function rawRgb(sharp, input) {
  return sharp(input, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function round4(value) {
  return Math.round(value * 10000) / 10000;
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
    } else if (value === "--mode") {
      parsed.mode = values[index + 1] || "";
      index += 1;
    } else if (value === "--keep-images") {
      parsed.keepImages = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
