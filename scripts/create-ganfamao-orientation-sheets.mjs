import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(repoRoot, "dist", "mockup-render-check", "ganfamao-orientation-sheets");
const templateRoot = path.join(outputDir, "templates");
const templateDir = path.join(templateRoot, "ganfamao");
const sourcePath = "D:/ozon/\u5546\u54c1\u56fe/\u5e72\u53d1\u5e3d/\u539f\u56fe/TJ20251116000279.png";
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

const templatePath = path.join(templateDir, "template.json");
const baseTemplate = JSON.parse(await fs.readFile(templatePath, "utf8"));
const scene = baseTemplate.scenes.find((item) => item.index === 1);
if (!scene) throw new Error("missing scene 1");
const baseLayer = scene.layers.find((layer) => layer.kind === "image" && layer.name === "1");
const linearLight = scene.layers.find((layer) => layer.blendMode === "linear_light");
const replacements = scene.layers.filter((layer) => layer.kind === "replace");

const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?orientationSheets=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);

for (const [layerIndex, replacement] of replacements.entries()) {
  const panels = [];
  for (const [orientationName, permutation] of Object.entries(orientationPermutations)) {
    const template = structuredClone(baseTemplate);
    const targetScene = template.scenes.find((item) => item.index === 1);
    const layer = structuredClone(replacement);
    layer.order = 1;
    layer.clipMask = "masks/scene-01-replace-007.png";
    layer.clipMaskLeft = 0;
    layer.clipMaskTop = 0;
    layer.clipMaskWidth = 800;
    layer.clipMaskHeight = 1067;
    layer.clipBaseName = "scene-1-full";
    applyOrientation(layer, permutation);
    targetScene.layers = [
      { ...baseLayer, order: 0 },
      layer,
      ...(linearLight ? [{ ...linearLight, order: 2 }] : []),
    ];
    template.scenes = [targetScene];
    await fs.writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    invalidateMockupTemplateCache("ganfamao");
    const rendered = await renderMockupsWithTemplate({
      templateDir: "ganfamao",
      sourceBuffer,
      sku: `L${layerIndex + 1}-${orientationName}`,
      sceneIndexes: [1],
    });
    panels.push(await createPanel(sharp, rendered.scenes[0].buffer, `${layerIndex + 1} ${orientationName}`));
  }
  const sheetPath = path.join(outputDir, `layer-${layerIndex + 1}-orientations.jpg`);
  await sharp({
    create: {
      width: 4 * 260 + 3 * 10,
      height: 2 * 385 + 10,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({
      input,
      left: (index % 4) * 270,
      top: Math.floor(index / 4) * 395,
    })))
    .jpeg({ quality: 90 })
    .toFile(sheetPath);
  console.log(sheetPath);
}

function applyOrientation(layer, permutation) {
  if (!Array.isArray(layer.transform) || layer.transform.length !== 8) return;
  const points = [
    [layer.transform[0], layer.transform[1]],
    [layer.transform[2], layer.transform[3]],
    [layer.transform[4], layer.transform[5]],
    [layer.transform[6], layer.transform[7]],
  ];
  layer.transform = permutation.flatMap((index) => points[index]);
  layer.psTransform = layer.transform;
}

async function createPanel(sharp, buffer, label) {
  const image = await sharp(buffer)
    .resize(260, 347, { fit: "contain", background: "#f8fafc" })
    .jpeg({ quality: 88 })
    .toBuffer();
  const labelSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="260" height="38">
      <rect width="100%" height="100%" fill="#111827"/>
      <text x="8" y="25" font-family="Arial, sans-serif" font-size="15" fill="#ffffff">${label}</text>
    </svg>
  `);
  return sharp({
    create: {
      width: 260,
      height: 385,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      { input: labelSvg, left: 0, top: 0 },
      { input: image, left: 0, top: 38 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}
