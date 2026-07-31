import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-boost-combo"));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuBoostCombo=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await collectSamples(sourceDir, referenceRoot);

const candidates = [
  { name: "baseline-red", boosts: [] },
  {
    name: "softgap-low-scenes-1-2-5-7-8",
    boosts: [
      {
        scene: 1,
        opacity: 0.02,
        mask: "masks/scene-01-boost-softgap.png",
        source: path.join(repoRoot, ".codex-work", "zhuobu-boost-mask-scene1-v37", "masks", "scene-01-boost-softgap.png"),
      },
      {
        scene: 2,
        opacity: 0.04,
        mask: "masks/scene-02-boost-softgap.png",
        source: path.join(repoRoot, ".codex-work", "zhuobu-boost-mask-scene2-v37", "masks", "scene-02-boost-softgap.png"),
      },
      {
        scene: 5,
        opacity: 0.02,
        mask: "masks/scene-05-boost-softgap.png",
        source: path.join(repoRoot, ".codex-work", "zhuobu-boost-mask-scene5-v37", "masks", "scene-05-boost-softgap.png"),
      },
      {
        scene: 7,
        opacity: 0.02,
        mask: "masks/scene-07-boost-softgap.png",
        source: path.join(repoRoot, ".codex-work", "zhuobu-boost-mask-scene7-v37", "masks", "scene-07-boost-softgap.png"),
      },
      {
        scene: 8,
        opacity: 0.02,
        mask: "masks/scene-08-boost-softgap.png",
        source: path.join(repoRoot, ".codex-work", "zhuobu-boost-mask-scene8-v37", "masks", "scene-08-boost-softgap.png"),
      },
    ],
  },
];

const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await mirrorTemplateAssets(baseDir, targetDir);
  const template = structuredClone(baseTemplate);
  for (const boost of candidate.boosts) {
    await fs.copyFile(boost.source, path.join(targetDir, boost.mask));
    addBoostLayer(template, boost);
  }
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rows = [];
  for (const sample of samples) {
    const rendered = await renderMockupsWithTemplate({
      templateDir: candidate.name,
      sourceBuffer: await fs.readFile(sample.sourcePath),
      sku: sample.sku,
    });
    for (const scene of rendered.scenes) {
      const referenceBuffer = await fs.readFile(sample.refs[scene.index]);
      const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
      rows.push({
        sku: sample.sku,
        scene: scene.index,
        mae: Number(mae.toFixed(3)),
        similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
      });
    }
  }
  const summary = summarize(candidate.name, rows);
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.averageSimilarity,
    firstEight: summary.firstEightSimilarity,
    worst: summary.worstSimilarity,
    scene1: summary.sceneSummary.find((item) => item.scene === 1),
    scene5: summary.sceneSummary.find((item) => item.scene === 5),
  }));
}

await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((item) => item.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.map((item) => ({
  name: item.name,
  average: item.averageSimilarity,
  firstEight: item.firstEightSimilarity,
  worst: item.worstSimilarity,
  scene1: item.sceneSummary.find((scene) => scene.scene === 1)?.similarity,
  scene5: item.sceneSummary.find((scene) => scene.scene === 5)?.similarity,
})));
console.log(path.join(outputDir, "summary.json"));

function addBoostLayer(template, boost) {
  const scene = template.scenes.find((item) => item.index === boost.scene);
  if (!scene) throw new Error(`Scene not found: ${boost.scene}`);
  const replace = scene.layers.find((layer) => layer.kind === "replace");
  if (!replace) throw new Error(`Replace layer not found: ${boost.scene}`);
  const layer = structuredClone(replace);
  layer.name = `${replace.name} boost`;
  layer.order = replace.order + 0.1;
  layer.opacity = boost.opacity;
  layer.mask = boost.mask;
  layer.edgeFeather = 0;
  scene.layers.push(layer);
  scene.layers.sort((left, right) => left.order - right.order).forEach((item, index) => {
    item.order = index;
  });
}

async function collectSamples(root, referenceRoot) {
  const files = (await fs.readdir(root)).filter((file) => /\.(png|jpe?g|webp)$/i.test(file)).sort();
  const output = [];
  for (const file of files) {
    const sku = path.basename(file, path.extname(file));
    const refs = await completeReferenceFiles(referenceRoot, sku);
    if (refs) output.push({ sku, sourcePath: path.join(root, file), refs });
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
    if (complete) return refs;
  }
  return null;
}

async function mirrorTemplateAssets(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    if (entry.name === "template.json") continue;
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      await mirrorTemplateAssets(sourcePath, targetPath);
    } else if (entry.isFile()) {
      try {
        await fs.link(sourcePath, targetPath);
      } catch (error) {
        if (error?.code !== "EEXIST") await fs.copyFile(sourcePath, targetPath);
      }
    }
  }
}

function summarize(name, rows) {
  const sceneSummary = [];
  for (const scene of [...new Set(rows.map((row) => row.scene))].sort((left, right) => left - right)) {
    const sceneRows = rows.filter((row) => row.scene === scene);
    sceneSummary.push({
      scene,
      similarity: Number(average(sceneRows.map((row) => row.similarity)).toFixed(2)),
      worstSimilarity: Number(Math.min(...sceneRows.map((row) => row.similarity)).toFixed(2)),
    });
  }
  return {
    name,
    averageSimilarity: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
    firstEightSimilarity: Number(average(rows.filter((row) => row.scene <= 8).map((row) => row.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
    sceneSummary,
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
    }
  }
  return parsed;
}
