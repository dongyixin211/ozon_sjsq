import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene-mesh-nudge"));
const templateRoot = path.join(outputDir, "templates");
const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

const sceneIndexes = (args.scenes || "1,5")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0);
const nameFilters = (args.nameContains || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuSceneMeshNudge=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const samples = await collectSamples(sourceDir, referenceRoot);
if (!samples.length) {
  throw new Error("没有找到可用的桌布样机样本");
}

const candidates = buildCandidates()
  .filter((candidate) => !nameFilters.length || nameFilters.some((filter) => candidate.name.includes(filter)));
const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await mirrorTemplateAssets(baseDir, targetDir);
  const template = structuredClone(baseTemplate);
  candidate.mutate(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rows = [];
  for (const sample of samples) {
    const rendered = await renderMockupsWithTemplate({
      templateDir: candidate.name,
      sourceBuffer: await fs.readFile(sample.sourcePath),
      sku: sample.sku,
      sceneIndexes: [candidate.scene],
    });
    const scene = rendered.scenes[0];
    if (args.keepImages === "true") {
      await fs.writeFile(path.join(outputDir, `${candidate.name}-${sample.sku}-cloud-${String(candidate.scene).padStart(2, "0")}.png`), scene.buffer);
    }
    const referenceBuffer = await fs.readFile(sample.refs[candidate.scene]);
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    rows.push({
      sku: sample.sku,
      scene: candidate.scene,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(3)),
    });
  }
  const summary = {
    name: candidate.name,
    scene: candidate.scene,
    meta: candidate.meta,
    averageSimilarity: round3(average(rows.map((row) => row.similarity))),
    worstSimilarity: round3(Math.min(...rows.map((row) => row.similarity))),
    rows,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    scene: summary.scene,
    name: summary.name,
    averageSimilarity: summary.averageSimilarity,
    worstSimilarity: summary.worstSimilarity,
    meta: summary.meta,
  }));
}

summaries.sort((left, right) => (
  right.averageSimilarity - left.averageSimilarity
  || right.worstSimilarity - left.worstSimilarity
));
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");
console.table(summaries.slice(0, 40).map((item) => ({
  scene: item.scene,
  name: item.name,
  average: item.averageSimilarity,
  worst: item.worstSimilarity,
  ...item.meta,
})));
console.log(path.join(outputDir, "summary.json"));

function buildCandidates() {
  const output = [];
  const amounts = [-8, -6, -4, -2, -1, 1, 2, 4, 6, 8];
  for (const sceneIndex of sceneIndexes) {
    output.push({ scene: sceneIndex, name: `scene${sceneIndex}-baseline`, meta: { mode: "baseline" }, mutate: () => {} });
    for (const axis of ["x", "y"]) {
      for (const amount of amounts) {
        for (const region of ["bottom", "lower-left", "lower-right", "center-low", "left", "right"]) {
          output.push({
            scene: sceneIndex,
            name: `scene${sceneIndex}-${region}-${axis}${signed(amount)}`,
            meta: { region, axis, amount },
            mutate: (template) => nudgeScene(template, sceneIndex, ({ uv, add }) => {
              const weight = regionWeight(region, uv);
              add(axis === "x" ? amount * weight : 0, axis === "y" ? amount * weight : 0);
            }),
          });
        }
      }
    }
    for (const amountX of [-4, -2, 2, 4]) {
      for (const amountY of [-4, -2, 2, 4]) {
        for (const region of ["bottom", "lower-left", "lower-right"]) {
          output.push({
            scene: sceneIndex,
            name: `scene${sceneIndex}-${region}-xy${signed(amountX)}-${signed(amountY)}`,
            meta: { region, amountX, amountY },
            mutate: (template) => nudgeScene(template, sceneIndex, ({ uv, add }) => {
              const weight = regionWeight(region, uv);
              add(amountX * weight, amountY * weight);
            }),
          });
        }
      }
    }
  }
  return output;
}

function nudgeScene(template, sceneIndex, fn) {
  const scene = template.scenes.find((item) => item.index === sceneIndex);
  const layer = scene?.layers.find((item) => item.kind === "replace" && item.perspectiveMesh);
  const mesh = layer?.perspectiveMesh;
  if (!mesh) {
    throw new Error(`scene ${sceneIndex} mesh missing`);
  }
  mesh.warpedVertices = mesh.warpedVertices.map((point, index) => {
    let dx = 0;
    let dy = 0;
    fn({
      uv: mesh.vertices[index],
      add: (x, y) => {
        dx += x;
        dy += y;
      },
    });
    return {
      x: round3(point.x + dx),
      y: round3(point.y + dy),
    };
  });
}

function regionWeight(region, uv) {
  if (region === "bottom") {
    return smoothstep(0.65, 1, uv.y);
  }
  if (region === "lower-left") {
    return smoothstep(0.65, 1, uv.y) * smoothstep(0.45, 0, uv.x);
  }
  if (region === "lower-right") {
    return smoothstep(0.65, 1, uv.y) * smoothstep(0.55, 1, uv.x);
  }
  if (region === "center-low") {
    return Math.max(0, 1 - Math.abs(uv.x - 0.5) / 0.5) * Math.max(0, 1 - Math.abs(uv.y - 0.8) / 0.35);
  }
  if (region === "left") {
    return smoothstep(0.45, 0, uv.x);
  }
  if (region === "right") {
    return smoothstep(0.55, 1, uv.x);
  }
  return 0;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

async function mirrorTemplateAssets(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true });
  for (const entry of await fs.readdir(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);
    if (entry.name === "template.json") continue;
    if (entry.isDirectory()) {
      await mirrorTemplateAssets(sourcePath, targetPath);
    } else if (entry.isFile()) {
      try {
        await fs.link(sourcePath, targetPath);
      } catch (error) {
        if (error?.code !== "EEXIST") {
          await fs.copyFile(sourcePath, targetPath);
        }
      }
    }
  }
}

async function collectSamples(root, referenceRoot) {
  const files = (await fs.readdir(root))
    .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
    .sort();
  const output = [];
  for (const file of files) {
    const sku = path.basename(file, path.extname(file));
    const refs = await completeReferenceFiles(referenceRoot, sku);
    if (!refs) continue;
    output.push({ sku, sourcePath: path.join(root, file), refs });
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

function round3(value) {
  return Number(value.toFixed(3));
}

function signed(value) {
  return value > 0 ? `+${value}` : `${value}`;
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
    } else if (value === "--keep-images") {
      parsed.keepImages = values[index + 1] || "";
      index += 1;
    } else if (value === "--name-contains") {
      parsed.nameContains = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
