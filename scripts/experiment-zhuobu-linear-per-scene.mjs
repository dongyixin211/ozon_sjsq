import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-linear-per-scene"));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?linearPerScene=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const sku = path.basename(sourcePath, path.extname(sourcePath));
const sceneIndexes = (args.scenes
  ? args.scenes.split(",").map((item) => Number(item.trim())).filter(Boolean)
  : baseTemplate.scenes
  .filter((scene) => scene.layers.some((layer) => layer.blendMode === "linear_light"))
    .map((scene) => scene.index));
const strengths = (args.strengths || "0,0.14,0.25,0.36,0.55,0.9")
  .split(",")
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item));

const summaries = [];
for (const sceneIndex of sceneIndexes) {
  for (const strength of strengths) {
    const name = `scene-${sceneIndex}-linear-${slug(strength)}`;
    const targetDir = path.join(templateRoot, name);
    await fs.cp(baseDir, targetDir, { recursive: true });
    const template = structuredClone(baseTemplate);
    setSceneLinearStrength(template, sceneIndex, strength);
    await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
    invalidateMockupTemplateCache(name);

    const rendered = await renderMockupsWithTemplate({ templateDir: name, sourceBuffer, sku, sceneIndexes: [sceneIndex] });
    const scene = rendered.scenes[0];
    const cloudPath = path.join(outputDir, `${name}-cloud-${String(sceneIndex).padStart(2, "0")}.png`);
    if (strength === 0.25 || strength === 0 || strength === 0.55 || strength === 1) {
      await fs.writeFile(cloudPath, scene.buffer);
    }
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${String(sceneIndex).padStart(2, "0")}.gif`));
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    const summary = {
      scene: sceneIndex,
      strength,
      name,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
      cloudPath,
    };
    summaries.push(summary);
    console.log(JSON.stringify({ scene: sceneIndex, strength, similarity: summary.similarity }));
  }
}

const bestByScene = [];
for (const sceneIndex of sceneIndexes) {
  const best = summaries
    .filter((item) => item.scene === sceneIndex)
    .sort((left, right) => right.similarity - left.similarity)[0];
  bestByScene.push(best);
}

await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ bestByScene, summaries }, null, 2)}\n`, "utf8");
console.table(bestByScene.map((item) => ({
  scene: item.scene,
  strength: item.strength,
  similarity: item.similarity,
  mae: item.mae,
})));
console.log(path.join(outputDir, "summary.json"));

function setSceneLinearStrength(template, sceneIndex, strength) {
  const scene = template.scenes.find((item) => item.index === sceneIndex);
  if (!scene) throw new Error(`scene not found: ${sceneIndex}`);
  scene.linearLightStrength = strength;
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

async function rawRgb(sharp, buffer) {
  return sharp(buffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function slug(value) {
  return String(value).replace(".", "p");
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
