import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = "D:/ozon/商品图/桌布/原图/TM20251026002593.png";
const referenceDir = "D:/ozon/商品图/桌布/套图/TM20251026002593/images";
const outputDir = path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-experiments");
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuExperiment=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const candidates = [
  {
    name: "fill-1600x960",
    mutate: (template) => {
      template.sourceWidth = 1600;
      template.sourceHeight = 960;
      template.sourceFit = "fill";
    },
  },
  {
    name: "cover-1600x960",
    mutate: (template) => {
      template.sourceWidth = 1600;
      template.sourceHeight = 960;
      template.sourceFit = "cover";
    },
  },
  {
    name: "fill-1536x1024",
    mutate: (template) => {
      template.sourceWidth = 1536;
      template.sourceHeight = 1024;
      template.sourceFit = "fill";
    },
  },
  {
    name: "cover-1536x1024",
    mutate: (template) => {
      template.sourceWidth = 1536;
      template.sourceHeight = 1024;
      template.sourceFit = "cover";
    },
  },
  {
    name: "fill-1600x960-no-duplicate-replace",
    mutate: (template) => {
      template.sourceWidth = 1600;
      template.sourceHeight = 960;
      template.sourceFit = "fill";
      removeDuplicateReplacements(template);
    },
  },
  {
    name: "cover-1600x960-no-duplicate-replace",
    mutate: (template) => {
      template.sourceWidth = 1600;
      template.sourceHeight = 960;
      template.sourceFit = "cover";
      removeDuplicateReplacements(template);
    },
  },
  {
    name: "fill-1600x960-supersample4",
    mutate: (template) => {
      template.sourceWidth = 1600;
      template.sourceHeight = 960;
      template.sourceFit = "fill";
      setReplaceOptions(template, { sampleMode: "center", interpolation: "supersample4" });
    },
  },
  {
    name: "fill-1600x960-edge-bilinear",
    mutate: (template) => {
      template.sourceWidth = 1600;
      template.sourceHeight = 960;
      template.sourceFit = "fill";
      setReplaceOptions(template, { sampleMode: "edge", interpolation: "bilinear" });
    },
  },
  {
    name: "fill-1600x960-center-bilinear",
    mutate: (template) => {
      template.sourceWidth = 1600;
      template.sourceHeight = 960;
      template.sourceFit = "fill";
      setReplaceOptions(template, { sampleMode: "center", interpolation: "bilinear" });
    },
  },
  {
    name: "fill-1600x960-edge-bicubic",
    mutate: (template) => {
      template.sourceWidth = 1600;
      template.sourceHeight = 960;
      template.sourceFit = "fill";
      setReplaceOptions(template, { sampleMode: "edge", interpolation: "bicubic" });
    },
  },
];

const summaries = [];
for (const candidate of candidates) {
  const slug = candidate.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  const targetDir = path.join(templateRoot, slug);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  candidate.mutate(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(slug);
  const rendered = await renderMockupsWithTemplate({ templateDir: slug, sourceBuffer, sku });
  const metrics = [];
  for (const scene of rendered.scenes) {
    const referencePath = path.join(referenceDir, `111_${sku}_${String(scene.index).padStart(2, "0")}.gif`);
    const referenceBuffer = await fs.readFile(referencePath);
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    metrics.push(Number(mae.toFixed(3)));
  }
  const average = metrics.reduce((sum, value) => sum + value, 0) / metrics.length;
  summaries.push({
    name: candidate.name,
    average: Number(average.toFixed(3)),
    similarity: Number((100 - (average / 255) * 100).toFixed(2)),
    metrics,
  });
  console.log(JSON.stringify(summaries[summaries.length - 1]));
}

summaries.sort((left, right) => left.average - right.average);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
console.table(summaries.map((item) => ({
  name: item.name,
  average: item.average,
  similarity: item.similarity,
})));

function removeDuplicateReplacements(template) {
  for (const scene of template.scenes) {
    const seen = new Set();
    scene.layers = scene.layers.filter((layer) => {
      if (layer.kind !== "replace") {
        return true;
      }
      const key = JSON.stringify(layer.transform || [layer.left, layer.top, layer.width, layer.height]);
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }
}

function setReplaceOptions(template, options) {
  for (const scene of template.scenes) {
    for (const layer of scene.layers) {
      if (layer.kind !== "replace") {
        continue;
      }
      if (options.sampleMode) {
        layer.sampleMode = options.sampleMode;
      }
      if (options.interpolation) {
        layer.interpolation = options.interpolation;
      }
    }
  }
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
