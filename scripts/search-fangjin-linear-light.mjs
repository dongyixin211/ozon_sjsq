import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceDir = "D:/ozon/商品图/原图";
const psRoot = "D:/ozon/商品图/套图";
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

const sceneIndex = Number(process.argv[2] || 3);
const strengths = (process.argv[3] || "0.98,1,1.02,1.04,1.06,1.08,1.1,1.12")
  .split(",")
  .map(Number)
  .filter(Number.isFinite);
const options = parseOptionArgs(process.argv.slice(4));
const outputPath = options.output ? path.resolve(repoRoot, options.output) : "";

const { default: sharp } = await import(sharpPath);
const { renderFangjinMockups } = await import(`${rendererPath}?linearLight=${sceneIndex}_${Date.now()}`);
const samples = await discoverSamples();
const sampleInputs = await Promise.all(samples.map(async (sample) => ({
  ...sample,
  sourceBuffer: await fs.readFile(sample.sourcePath),
  psDirectBuffer: await sharp(sample.psScenePath, { animated: false }).toBuffer(),
})));

const rows = [];
if (outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, "", "utf8");
}
for (const strength of strengths) {
  const values = [];
  for (const sample of sampleInputs) {
    const rendered = await renderFangjinMockups({
      sourceBuffer: sample.sourceBuffer,
      sku: sample.sku,
      sceneIndexes: [sceneIndex],
      linearLightStrength: strength,
    });
    const scene = rendered.scenes.find((item) => item.index === sceneIndex);
    if (!scene) {
      throw new Error(`未找到场景 ${sceneIndex}`);
    }
    values.push(await calculateMae(sample.psDirectBuffer, scene.buffer));
  }
  rows.push({
    scene: sceneIndex,
    strength,
    directMae: Number(average(values).toFixed(3)),
  });
  rows.sort((left, right) => left.directMae - right.directMae);
  const best = rows[0];
  const current = rows.find((row) => row.strength === strength);
  console.log(`strength=${strength}, directMae=${current.directMae}; best=${best.strength}/${best.directMae}`);
  if (outputPath) {
    await fs.appendFile(outputPath, `${JSON.stringify(current)}\n`, "utf8");
  }
}

rows.sort((left, right) => left.directMae - right.directMae);
console.log(`样本数：${sampleInputs.length}，场景：${sceneIndex}`);
console.table(rows);

async function discoverSamples() {
  const sourceFiles = await fs.readdir(sourceDir, { withFileTypes: true });
  const sourcePathBySku = new Map();
  for (const entry of sourceFiles) {
    if (!entry.isFile()) {
      continue;
    }
    const parsed = path.parse(entry.name);
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(parsed.ext.toLowerCase())) {
      continue;
    }
    sourcePathBySku.set(parsed.name, path.join(sourceDir, entry.name));
  }

  const psDirs = await fs.readdir(psRoot, { withFileTypes: true });
  const samples = [];
  for (const entry of psDirs) {
    if (!entry.isDirectory() || !sourcePathBySku.has(entry.name)) {
      continue;
    }
    const psScenePath = path.join(psRoot, entry.name, "images", `111_${entry.name}_${String(sceneIndex).padStart(2, "0")}.gif`);
    try {
      await fs.access(psScenePath);
    } catch {
      continue;
    }
    samples.push({
      sku: entry.name,
      sourcePath: sourcePathBySku.get(entry.name),
      psScenePath,
    });
  }
  return samples.sort((left, right) => left.sku.localeCompare(right.sku));
}

async function calculateMae(psBuffer, cloudBuffer) {
  const [ps, cloud] = await Promise.all([
    sharp(psBuffer).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(cloudBuffer).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  let sum = 0;
  for (let offset = 0; offset < ps.data.length; offset += 3) {
    sum += (
      Math.abs(ps.data[offset] - cloud.data[offset])
      + Math.abs(ps.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(ps.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
  }
  return sum / (ps.data.length / 3);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function parseOptionArgs(args) {
  const parsed = { output: "" };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--output") {
      parsed.output = args[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
