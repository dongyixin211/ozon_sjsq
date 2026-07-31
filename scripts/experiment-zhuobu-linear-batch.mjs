import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-linear-batch"));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?linearBatch=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const samples = [];
for (const file of (await fs.readdir(sourceDir)).filter((item) => /\.(png|jpe?g|webp)$/i.test(item)).sort()) {
  const sku = path.basename(file, path.extname(file));
  const refs = await completeReferenceFiles(referenceRoot, sku);
  if (!refs) {
    continue;
  }
  samples.push({
    sku,
    sourcePath: path.join(sourceDir, file),
    refs,
  });
}

const sceneIndexes = (args.scenes
  ? args.scenes.split(",").map((value) => Number(value.trim())).filter(Boolean)
  : baseTemplate.scenes
    .filter((scene) => scene.layers.some((layer) => layer.blendMode === "linear_light"))
    .map((scene) => scene.index));
const strengths = (args.strengths || "0,0.08,0.14,0.2,0.25,0.32,0.36,0.42,0.5,0.6,0.7")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value));

const summaries = [];
for (const sceneIndex of sceneIndexes) {
  const baselineStrength = baseTemplate.scenes.find((scene) => scene.index === sceneIndex)?.linearLightStrength ?? baseTemplate.linearLightStrength ?? 0.25;
  const sceneStrengths = [...new Set([...strengths, baselineStrength])].sort((left, right) => left - right);
  for (const strength of sceneStrengths) {
    const name = `scene-${sceneIndex}-linear-${slug(strength)}`;
    const targetDir = path.join(templateRoot, name);
    await fs.cp(baseDir, targetDir, { recursive: true });
    const template = structuredClone(baseTemplate);
    setSceneLinearStrength(template, sceneIndex, strength);
    await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
    invalidateMockupTemplateCache(name);

    const rows = [];
    for (const sample of samples) {
      const rendered = await renderMockupsWithTemplate({
        templateDir: name,
        sourceBuffer: await fs.readFile(sample.sourcePath),
        sku: sample.sku,
        sceneIndexes: [sceneIndex],
      });
      const scene = rendered.scenes[0];
      const referenceBuffer = await fs.readFile(sample.refs[sceneIndex]);
      const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
      rows.push({
        sku: sample.sku,
        mae: Number(mae.toFixed(3)),
        similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
      });
    }
    const summary = {
      scene: sceneIndex,
      strength,
      baselineStrength,
      average: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
      worst: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
      rows,
    };
    summaries.push(summary);
    console.log(JSON.stringify({
      scene: sceneIndex,
      strength,
      average: summary.average,
      worst: summary.worst,
    }));
  }
}

const bestByScene = [];
for (const sceneIndex of sceneIndexes) {
  const candidates = summaries
    .filter((item) => item.scene === sceneIndex)
    .sort((left, right) => {
      if (right.average !== left.average) {
        return right.average - left.average;
      }
      return right.worst - left.worst;
    });
  bestByScene.push(candidates[0]);
}

await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), bestByScene, summaries }, null, 2)}\n`, "utf8");
console.table(bestByScene.map((item) => ({
  scene: item.scene,
  strength: item.strength,
  baseline: item.baselineStrength,
  average: item.average,
  worst: item.worst,
})));
console.log(path.join(outputDir, "summary.json"));

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

function setSceneLinearStrength(template, sceneIndex, strength) {
  const scene = template.scenes.find((item) => item.index === sceneIndex);
  if (!scene) throw new Error(`scene not found: ${sceneIndex}`);
  scene.linearLightStrength = strength;
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

function slug(value) {
  return String(value).replace(".", "p");
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
    } else if (value === "--strengths") {
      parsed.strengths = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
