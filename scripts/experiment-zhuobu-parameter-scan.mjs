import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-parameter-scan"));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuParamScan=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const candidates = [
  ["baseline", () => {}],
  ...[0, 0.1, 0.18, 0.25, 0.32, 0.4, 0.5, 0.65, 0.8].map((value) => [
    `linear-${String(value).replace(".", "-")}`,
    (template) => { template.linearLightStrength = value; },
  ]),
  ...["nearest", "bilinear", "bicubic", "bicubic-ps", "bicubic-soft", "mitchell", "lanczos2", "lanczos3", "supersample2", "supersample3", "supersample4", "supersample5"].map((value) => [
    `interp-${value}`,
    (template) => setReplaceOptions(template, { interpolation: value }),
  ]),
  ...["edge", "center"].map((value) => [
    `sample-${value}`,
    (template) => setReplaceOptions(template, { sampleMode: value }),
  ]),
  ...[
    [-0.5, -0.5],
    [-0.1875, -0.5],
    [0, 0],
    [0.25, 0.25],
    [0.5, 0.5],
    [-0.5, 0],
    [0, -0.5],
  ].map(([x, y]) => [
    `offset-${String(x).replace("-", "m").replace(".", "p")}-${String(y).replace("-", "m").replace(".", "p")}`,
    (template) => setReplaceOptions(template, { pixelOffsetX: x, pixelOffsetY: y }),
  ]),
];

const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const summaries = [];

for (const [name, mutate] of candidates) {
  const targetDir = path.join(templateRoot, name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  mutate(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(name);

  const rendered = await renderMockupsWithTemplate({ templateDir: name, sourceBuffer, sku });
  const metrics = [];
  for (const scene of rendered.scenes) {
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${String(scene.index).padStart(2, "0")}.gif`));
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
    worstFirstEight: Number(Math.min(...metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    metrics,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.average,
    firstEight: summary.firstEight,
    worstFirstEight: summary.worstFirstEight,
  }));
}

summaries.sort((left, right) => right.firstEight - left.firstEight);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
console.table(summaries.slice(0, 12).map((item) => ({
  name: item.name,
  average: item.average,
  firstEight: item.firstEight,
  worstFirstEight: item.worstFirstEight,
})));
console.log(path.join(outputDir, "summary.json"));

function setReplaceOptions(template, options) {
  for (const scene of template.scenes) {
    for (const layer of scene.layers) {
      if (layer.kind !== "replace") {
        continue;
      }
      Object.assign(layer, options);
    }
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
  return sum / (reference.data.length / 3);
}

async function rawRgb(sharp, buffer) {
  return sharp(buffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
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
