import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sceneIndex = Number(args.scene || 7);
const sceneId = String(sceneIndex).padStart(2, "0");
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", `zhuobu-scene${sceneId}-params`));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuSceneParams=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await collectSamples(sourceDir, referenceRoot);
if (!samples.length) {
  throw new Error("没有找到可用于桌布样机参数扫描的样本");
}

const candidates = buildCandidates(args);
const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  candidate.mutate(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rows = [];
  for (const sample of samples) {
    const sourceBuffer = await fs.readFile(sample.sourcePath);
    const rendered = await renderMockupsWithTemplate({
      templateDir: candidate.name,
      sourceBuffer,
      sku: sample.sku,
      sceneIndexes: [sceneIndex],
    });
    const renderedScene = rendered.scenes[0];
    if (args.keepImages === "true") {
      await fs.writeFile(path.join(outputDir, `${candidate.name}-${sample.sku}-cloud-${sceneId}.png`), renderedScene.buffer);
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
  const summary = summarize(candidate.name, candidate.meta, rows);
  summaries.push(summary);
  console.log(JSON.stringify({
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
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ scene: sceneIndex, samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.slice(0, 30).map((item) => ({
  name: item.name,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
  ...item.meta,
})));
console.log(path.join(outputDir, "summary.json"));

function buildCandidates(options) {
  const output = [{ name: "baseline", meta: {}, mutate: () => {} }];
  if (!options.mode || options.mode === "light") {
    for (const strength of [0, 0.08, 0.12, 0.16, 0.18, 0.22, 0.26, 0.3, 0.36, 0.44, 0.52, 0.6, 0.7, 0.8, 1]) {
      output.push({
        name: `ll-${slugNumber(strength)}`,
        meta: { ll: strength },
        mutate: (template) => {
          scene(template).linearLightStrength = strength;
        },
      });
    }
  }
  if (!options.mode || options.mode === "sampling") {
    for (const sampleMode of ["edge", "center"]) {
      for (const interpolation of ["bilinear", "supersample2", "supersample3", "supersample4", "supersample5", "bicubic", "bicubic-ps", "bicubic-soft", "mitchell", "lanczos2", "lanczos3"]) {
        output.push({
          name: `${sampleMode}-${interpolation}`,
          meta: { sampleMode, interpolation },
          mutate: (template) => {
            for (const layer of scene(template).layers) {
              if (layer.kind !== "replace") continue;
              layer.sampleMode = sampleMode;
              layer.interpolation = interpolation;
            }
          },
        });
      }
    }
  }
  if (!options.mode || options.mode === "offset") {
    for (const offsetX of [-1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25]) {
      for (const offsetY of [-1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25]) {
        if (offsetX === 0 && offsetY === 0) continue;
        output.push({
          name: `off-x${slugNumber(offsetX)}-y${slugNumber(offsetY)}`,
          meta: { offsetX, offsetY },
          mutate: (template) => {
            const targetScene = scene(template);
            targetScene.pixelOffsetX = offsetX;
            targetScene.pixelOffsetY = offsetY;
          },
        });
      }
    }
  }
  return output;
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
    for (let item = 1; item <= 9; item += 1) {
      const file = path.join(refDir, `111_${sku}_${String(item).padStart(2, "0")}.gif`);
      try {
        await fs.access(file);
        refs[item] = file;
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

function scene(template) {
  const targetScene = template.scenes.find((item) => item.index === sceneIndex);
  if (!targetScene) {
    throw new Error(`未找到场景 ${sceneIndex}`);
  }
  return targetScene;
}

function summarize(name, meta, rows) {
  return {
    name,
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
    } else if (value === "--scene") {
      parsed.scene = values[index + 1] || "";
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
