import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(repoRoot, "dist", "mockup-render-check", "ganfamao-scene1-search");
const templateRoot = path.join(outputDir, "templates");
const templateDir = path.join(templateRoot, "ganfamao");
const sourcePath = "D:/ozon/商品图/干发帽/原图/TJ20251116000279.png";
const referencePath = "D:/ozon/商品图/干发帽/套图/TJ20251116000279/111_TJ20251116000279_01.jpg";
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT = templateRoot;

const orientationPermutations = {
  identity: [0, 1, 2, 3],
  rotate90: [3, 0, 1, 2],
  rotate180: [2, 3, 0, 1],
  rotate270: [1, 2, 3, 0],
  flipX: [1, 0, 3, 2],
  flipY: [3, 2, 1, 0],
  transpose: [0, 3, 2, 1],
  transverse: [2, 1, 0, 3],
};

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(templateRoot, { recursive: true });
await fs.cp(path.join(repoRoot, "server", "src", "mockup-templates", "ganfamao"), templateDir, { recursive: true });

const baseTemplatePath = path.join(templateDir, "template.json");
const baseTemplate = JSON.parse(await fs.readFile(baseTemplatePath, "utf8"));
const scene = baseTemplate.scenes.find((item) => item.index === 1);
if (!scene) throw new Error("missing scene 1");

const replacementLayers = scene.layers.filter((layer) => layer.kind === "replace");
if (replacementLayers.length !== 3) {
  throw new Error(`expected 3 scene 1 replacements, got ${replacementLayers.length}`);
}

for (const layer of replacementLayers) {
  layer.fullClipMask = "masks/scene-01-replace-007.png";
}

const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?scene1Search=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const referenceBuffer = await fs.readFile(referencePath);
const orientationNames = Object.keys(orientationPermutations);
const results = [];
let best = null;

for (const first of orientationNames) {
  for (const second of orientationNames) {
    for (const third of orientationNames) {
      const template = structuredClone(baseTemplate);
      const targetScene = template.scenes.find((item) => item.index === 1);
      const targets = targetScene.layers.filter((layer) => layer.kind === "replace");
      applyOrientation(targets[0], first);
      applyOrientation(targets[1], second);
      applyOrientation(targets[2], third);
      for (const layer of targets) {
        layer.clipMask = "masks/scene-01-replace-007.png";
        layer.clipMaskLeft = 0;
        layer.clipMaskTop = 0;
        layer.clipMaskWidth = 800;
        layer.clipMaskHeight = 1067;
        layer.clipBaseName = "scene-1-full";
      }

      await fs.writeFile(baseTemplatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
      invalidateMockupTemplateCache("ganfamao");
      const rendered = await renderMockupsWithTemplate({
        templateDir: "ganfamao",
        sourceBuffer,
        sku: "TJ20251116000279",
        sceneIndexes: [1],
      });
      const cloudBuffer = rendered.scenes[0].buffer;
      const mae = await calculateMae(sharp, referenceBuffer, cloudBuffer);
      const row = {
        orientations: [first, second, third],
        mae,
      };
      results.push(row);
      if (!best || mae < best.mae) {
        best = row;
        await fs.writeFile(path.join(outputDir, "best-scene-01.png"), cloudBuffer);
        console.log("best", Number(mae.toFixed(3)), row.orientations.join(","));
      }
    }
  }
}

results.sort((left, right) => left.mae - right.mae);
await fs.writeFile(path.join(outputDir, "orientation-results.json"), `${JSON.stringify(results.slice(0, 40).map((row) => ({
  ...row,
  mae: Number(row.mae.toFixed(3)),
  similarity: Number((100 - (row.mae / 255) * 100).toFixed(2)),
})), null, 2)}\n`, "utf8");
console.table(results.slice(0, 12).map((row) => ({
  mae: Number(row.mae.toFixed(3)),
  similarity: Number((100 - (row.mae / 255) * 100).toFixed(2)),
  orientations: row.orientations.join(","),
})));
console.log(path.join(outputDir, "best-scene-01.png"));

function applyOrientation(layer, orientationName) {
  if (!Array.isArray(layer.transform) || layer.transform.length !== 8) {
    return;
  }
  const points = [
    [layer.transform[0], layer.transform[1]],
    [layer.transform[2], layer.transform[3]],
    [layer.transform[4], layer.transform[5]],
    [layer.transform[6], layer.transform[7]],
  ];
  const permutation = orientationPermutations[orientationName] || orientationPermutations.identity;
  layer.transform = permutation.flatMap((index) => points[index]);
  layer.psTransform = layer.transform;
  layer.orientation = orientationName;
}

async function calculateMae(sharp, referenceBuffer, cloudBuffer) {
  const reference = await sharp(referenceBuffer)
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
