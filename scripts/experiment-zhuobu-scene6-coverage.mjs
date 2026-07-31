import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene6-coverage"));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?scene6Coverage=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const sku = path.basename(sourcePath, path.extname(sourcePath));
const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_06.gif`));

const candidates = [
  ["baseline", () => {}],
  ["remove-small-normal", (template) => removeScene6NormalSmallLayers(template)],
  ["alpha-masks", async (_template, targetDir) => convertScene6MasksToAlpha(targetDir)],
  ["alpha-masks-positioned", async (template, targetDir) => {
    await convertScene6MasksToAlpha(targetDir);
    setScene6MasksPositioned(template);
  }],
  ["plain-transform", (template) => deleteScene6Meshes(template)],
  ["plain-transform-alpha", async (template, targetDir) => {
    deleteScene6Meshes(template);
    await convertScene6MasksToAlpha(targetDir);
  }],
  ["no-duplicate-replace", (template) => keepTopScene6ReplaceInEachPair(template)],
  ["remove-small-plus-alpha", async (template, targetDir) => {
    removeScene6NormalSmallLayers(template);
    await convertScene6MasksToAlpha(targetDir);
  }],
  ["remove-small-plain-transform", (template) => {
    removeScene6NormalSmallLayers(template);
    deleteScene6Meshes(template);
  }],
  ["remove-small-no-duplicates", (template) => {
    removeScene6NormalSmallLayers(template);
    keepTopScene6ReplaceInEachPair(template);
  }],
];

const summaries = [];
for (const [name, mutate] of candidates) {
  const targetDir = path.join(templateRoot, name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  await mutate(template, targetDir);
  normalizeScene6Orders(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(name);

  const rendered = await renderMockupsWithTemplate({ templateDir: name, sourceBuffer, sku, sceneIndexes: [6] });
  const cloudBuffer = rendered.scenes[0].buffer;
  const cloudPath = path.join(outputDir, `${name}-cloud-06.png`);
  await fs.writeFile(cloudPath, cloudBuffer);
  const metric = await calculateMae(sharp, referenceBuffer, cloudBuffer);
  summaries.push({ name, ...metric, cloudPath });
  console.log(JSON.stringify({ name, similarity: metric.similarity, mae: metric.mae }));
}

summaries.sort((left, right) => right.similarity - left.similarity);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
await createComparison(sharp, summaries, referenceBuffer, outputDir);

console.table(summaries.map((item) => ({
  name: item.name,
  similarity: item.similarity,
  mae: item.mae,
})));
console.log(path.join(outputDir, "summary.json"));
console.log(path.join(outputDir, "scene-06-compare.jpg"));

function scene6(template) {
  const scene = template.scenes.find((item) => item.index === 6);
  if (!scene) throw new Error("scene 6 not found");
  return scene;
}

function removeScene6NormalSmallLayers(template) {
  const removable = new Set(["图层 6", "图层 8", "图层 10"]);
  const scene = scene6(template);
  scene.layers = scene.layers.filter((layer) => !(layer.kind === "image" && removable.has(layer.name)));
}

function deleteScene6Meshes(template) {
  for (const layer of scene6(template).layers) {
    if (layer.kind === "replace") {
      delete layer.perspectiveMesh;
    }
  }
}

function keepTopScene6ReplaceInEachPair(template) {
  const scene = scene6(template);
  const keep = new Set([
    "桌布链接图 拷贝 17",
    "桌布链接图 拷贝 6",
    "桌布链接图 拷贝 15",
  ]);
  scene.layers = scene.layers.filter((layer) => layer.kind !== "replace" || keep.has(layer.name));
}

function setScene6MasksPositioned(template) {
  for (const layer of scene6(template).layers) {
    if (layer.kind !== "replace") continue;
    layer.maskLeft = 0;
    layer.maskTop = 0;
    layer.maskWidth = 800;
    layer.maskHeight = 1067;
  }
}

function normalizeScene6Orders(template) {
  const scene = scene6(template);
  scene.layers.sort((left, right) => left.order - right.order).forEach((layer, index) => {
    layer.order = index;
  });
}

async function convertScene6MasksToAlpha(targetDir) {
  const masks = [
    "masks/scene-06-replace-001.png",
    "masks/scene-06-replace-003.png",
    "masks/scene-06-replace-007.png",
    "masks/scene-06-replace-010.png",
    "masks/scene-06-replace-012.png",
  ];
  for (const relativePath of masks) {
    const inputPath = path.join(targetDir, relativePath);
    await sharp(inputPath).ensureAlpha().extractChannel("alpha").png().toFile(`${inputPath}.tmp.png`);
    await fs.rename(`${inputPath}.tmp.png`, inputPath);
  }
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
  const mae = sum / (reference.data.length / 3);
  return {
    mae: Number(mae.toFixed(3)),
    similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
  };
}

async function rawRgb(sharp, buffer) {
  return sharp(buffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function createComparison(sharp, summaries, referenceBuffer, outputDir) {
  const panels = [await labelPanel(sharp, referenceBuffer, "PS")];
  for (const summary of summaries) {
    panels.push(await labelPanel(sharp, await fs.readFile(summary.cloudPath), `${summary.name} ${summary.similarity}%`));
  }
  await sharp({
    create: {
      width: panels.length * 240 + (panels.length - 1) * 10,
      height: 364,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({ input, left: index * 250, top: 0 })))
    .jpeg({ quality: 90 })
    .toFile(path.join(outputDir, "scene-06-compare.jpg"));
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false }).resize({ width: 240, height: 320, fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="44"><rect width="240" height="44" fill="#111827"/><text x="8" y="28" font-family="Arial" font-size="13" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 240, height: 364, channels: 3, background: "#fff" } })
    .composite([{ input: svg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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
    }
  }
  return parsed;
}
