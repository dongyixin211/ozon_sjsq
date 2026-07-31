import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene7-mesh-batch"));
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?scene7MeshBatch=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const samples = [];
for (const file of (await fs.readdir(sourceDir)).filter((item) => /\.(png|jpe?g|webp)$/i.test(item)).sort()) {
  const sku = path.basename(file, path.extname(file));
  const referencePath = await findReference(referenceRoot, sku, 7);
  if (!referencePath) {
    continue;
  }
  samples.push({
    sku,
    sourcePath: path.join(sourceDir, file),
    referencePath,
  });
}

const candidates = createCandidates();
const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  mutateScene7Meshes(template, candidate);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rows = [];
  for (const sample of samples) {
    const rendered = await renderMockupsWithTemplate({
      templateDir: candidate.name,
      sourceBuffer: await fs.readFile(sample.sourcePath),
      sku: sample.sku,
      sceneIndexes: [7],
    });
    const scene = rendered.scenes[0];
    const referenceBuffer = await fs.readFile(sample.referencePath);
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    rows.push({
      sku: sample.sku,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
  }
  const summary = {
    ...candidate,
    average: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
    worst: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
    rows,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.average,
    worst: summary.worst,
  }));
}

summaries.sort((left, right) => right.average - left.average);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.slice(0, 20).map((item) => ({
  name: item.name,
  average: item.average,
  worst: item.worst,
})));
console.log(path.join(outputDir, "summary.json"));

function createCandidates() {
  return [
    { name: "baseline", topLift: 0, midLift: 0, scaleX: 1, scaleY: 1, dx: 0, dy: 0 },
    { name: "plain-transform", plain: true },
    ...[-120, -80, -40, 40, 80].map((topLift) => ({
      name: `top${slug(topLift)}`,
      topLift,
      midLift: topLift * 0.45,
      scaleX: 1,
      scaleY: 1,
      dx: 0,
      dy: 0,
    })),
    ...[0.96, 1.04].flatMap((scaleX) => [-80, -40, 40].map((topLift) => ({
      name: `sx${slug(scaleX)}-top${slug(topLift)}`,
      topLift,
      midLift: topLift * 0.45,
      scaleX,
      scaleY: 1,
      dx: 0,
      dy: 0,
    }))),
    ...[0.96, 1.04].map((scaleX) => ({
      name: `sx${slug(scaleX)}`,
      topLift: 0,
      midLift: 0,
      scaleX,
      scaleY: 1,
      dx: 0,
      dy: 0,
    })),
    ...[0.96, 1.04].map((scaleY) => ({
      name: `sy${slug(scaleY)}`,
      topLift: 0,
      midLift: 0,
      scaleX: 1,
      scaleY,
      dx: 0,
      dy: 0,
    })),
    ...[-40, 40].map((dy) => ({
      name: `dy${slug(dy)}`,
      topLift: 0,
      midLift: 0,
      scaleX: 1,
      scaleY: 1,
      dx: 0,
      dy,
    })),
  ];
}

function mutateScene7Meshes(template, candidate) {
  const scene = template.scenes.find((item) => item.index === 7);
  if (!scene) throw new Error("scene 7 not found");
  for (const layer of scene.layers) {
    if (layer.kind !== "replace") {
      continue;
    }
    if (candidate.plain) {
      delete layer.perspectiveMesh;
      continue;
    }
    if (!layer.perspectiveMesh) {
      continue;
    }
    const mesh = layer.perspectiveMesh;
    const centerX = average(mesh.warpedVertices.map((point) => point.x));
    const centerY = average(mesh.warpedVertices.map((point) => point.y));
    mesh.warpedVertices = mesh.warpedVertices.map((point, index) => {
      const source = mesh.vertices[index] || { x: 0.5, y: 0.5 };
      const topWeight = Math.max(0, 1 - Number(source.y || 0));
      const midWeight = 1 - Math.abs(Number(source.y || 0) - 0.5) * 2;
      return {
        x: round(centerX + (point.x - centerX) * (candidate.scaleX ?? 1) + (candidate.dx ?? 0)),
        y: round(centerY + (point.y - centerY) * (candidate.scaleY ?? 1)
          + (candidate.dy ?? 0)
          + (candidate.topLift ?? 0) * topWeight
          + (candidate.midLift ?? 0) * Math.max(0, midWeight)),
      };
    });
  }
}

async function findReference(root, sku, scene) {
  for (const dir of [path.join(root, sku), path.join(root, sku, "images")]) {
    const file = path.join(dir, `111_${sku}_${String(scene).padStart(2, "0")}.gif`);
    try {
      await fs.access(file);
      return file;
    } catch {
      // 尝试下一个目录。
    }
  }
  return null;
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

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function slug(value) {
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
    }
  }
  return parsed;
}
