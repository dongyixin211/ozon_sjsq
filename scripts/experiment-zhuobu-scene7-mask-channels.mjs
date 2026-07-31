import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene7-mask-channel-check"));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?scene7MaskChannels=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const sku = path.basename(sourcePath, path.extname(sourcePath));

const candidates = [
  ["baseline", () => {}],
  ["scene7-alpha-mask", async (targetDir, template) => {
    await convertScene7Masks(targetDir, "alpha");
    keepScene7Masks(template);
  }],
  ["scene7-red-alpha-mask", async (targetDir, template) => {
    await convertScene7Masks(targetDir, "red-alpha");
    keepScene7Masks(template);
  }],
  ["scene7-no-mask", async (_targetDir, template) => {
    forScene7Replace(template, (layer) => {
      delete layer.mask;
    });
  }],
  ["scene7-top-alpha-lower-red", async (targetDir, template) => {
    await convertOneMask(targetDir, "masks/scene-07-replace-003.png", "alpha");
    keepScene7Masks(template);
  }],
  ["scene7-top-red-lower-alpha", async (targetDir, template) => {
    await convertOneMask(targetDir, "masks/scene-07-replace-001.png", "alpha");
    keepScene7Masks(template);
  }],
];

const summaries = [];
for (const [name, mutate] of candidates) {
  const targetDir = path.join(templateRoot, name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const templatePath = path.join(targetDir, "template.json");
  const template = JSON.parse(await fs.readFile(templatePath, "utf8"));
  await mutate(targetDir, template);
  await fs.writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(name);

  const rendered = await renderMockupsWithTemplate({ templateDir: name, sourceBuffer, sku });
  const metrics = [];
  for (const scene of rendered.scenes) {
    const sceneId = String(scene.index).padStart(2, "0");
    await fs.writeFile(path.join(outputDir, `${name}-cloud-${sceneId}.png`), scene.buffer);
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${sceneId}.gif`));
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    metrics.push({
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
  }
  const summary = {
    name,
    average: Number(average(metrics.map((item) => item.similarity)).toFixed(2)),
    firstEight: Number(average(metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    scene7: metrics.find((item) => item.scene === 7)?.similarity,
    metrics,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.average,
    firstEight: summary.firstEight,
    scene7: summary.scene7,
  }));
}

await createSceneComparison(sharp, summaries, referenceDir, outputDir, sku, 7);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
console.table(summaries.map((item) => ({
  name: item.name,
  average: item.average,
  firstEight: item.firstEight,
  scene7: item.scene7,
})));
console.log(path.join(outputDir, "summary.json"));
console.log(path.join(outputDir, "scene-07-compare.jpg"));

function keepScene7Masks(template) {
  forScene7Replace(template, (layer) => {
    delete layer.clipMask;
  });
}

function forScene7Replace(template, callback) {
  const scene = template.scenes.find((item) => item.index === 7);
  for (const layer of scene.layers) {
    if (layer.kind === "replace") {
      callback(layer);
    }
  }
}

async function convertScene7Masks(targetDir, mode) {
  await convertOneMask(targetDir, "masks/scene-07-replace-001.png", mode);
  await convertOneMask(targetDir, "masks/scene-07-replace-003.png", mode);
}

async function convertOneMask(targetDir, relativePath, mode) {
  const inputPath = path.join(targetDir, relativePath);
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = Buffer.alloc(info.width * info.height);
  for (let source = 0, target = 0; source < data.length; source += 4, target += 1) {
    if (mode === "alpha") {
      output[target] = data[source + 3];
    } else if (mode === "red-alpha") {
      output[target] = Math.round((data[source] * data[source + 3]) / 255);
    } else {
      output[target] = data[source];
    }
  }
  await sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 1,
    },
  }).png().toFile(inputPath);
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

async function createSceneComparison(sharp, summaries, referenceDir, outputDir, sku, sceneIndex) {
  const sceneId = String(sceneIndex).padStart(2, "0");
  const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${sceneId}.gif`));
  const panels = [await labelPanel(sharp, referenceBuffer, `PS scene ${sceneIndex}`)];
  for (const summary of summaries) {
    const buffer = await fs.readFile(path.join(outputDir, `${summary.name}-cloud-${sceneId}.png`));
    panels.push(await labelPanel(sharp, buffer, `${summary.name} ${summary.scene7}%`));
  }
  await sharp({
    create: {
      width: panels.length * 300 + (panels.length - 1) * 10,
      height: 444,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({ input, left: index * 310, top: 0 })))
    .jpeg({ quality: 90 })
    .toFile(path.join(outputDir, `scene-${sceneId}-compare.jpg`));
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false }).resize({ width: 300, height: 400, fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="44"><rect width="300" height="44" fill="#111827"/><text x="10" y="28" font-family="Arial" font-size="15" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 300, height: 444, channels: 3, background: "#fff" } })
    .composite([{ input: svg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
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
