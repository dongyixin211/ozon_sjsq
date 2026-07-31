import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sku = args.sku || "TM20251025000433";
const sceneIndex = Number(args.scene || 7);
const referenceDir = path.resolve(args.referenceDir || `D:/ozon/商品图/桌布/套图/${sku}`);
const cloudDir = path.resolve(args.cloudDir || path.join(repoRoot, ".codex-work", "zhuobu-tm20251025000433-final-2"));
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", `zhuobu-scene-${sceneIndex}-region-diagnose`));
const templateDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

await fs.mkdir(outputDir, { recursive: true });
const { default: sharp } = await import(sharpPath);

const referencePath = path.join(referenceDir, `111_${sku}_${String(sceneIndex).padStart(2, "0")}.gif`);
const cloudPath = path.join(cloudDir, `cloud-${String(sceneIndex).padStart(2, "0")}.png`);
const template = JSON.parse(await fs.readFile(path.join(templateDir, "template.json"), "utf8"));
const scene = template.scenes.find((item) => item.index === sceneIndex);
if (!scene) {
  throw new Error(`scene not found: ${sceneIndex}`);
}
const baseLayer = scene.layers
  .filter((layer) => layer.kind === "image" && layer.blendMode === "normal" && layer.width === 800 && layer.height === 1067)
  .sort((left, right) => left.order - right.order)[0];
if (!baseLayer?.file) {
  throw new Error(`base layer not found: scene ${sceneIndex}`);
}

const reference = await readRaw(sharp, referencePath);
const cloud = await readRaw(sharp, cloudPath);
const base = await readRaw(sharp, path.join(templateDir, baseLayer.file));
const width = reference.info.width;
const height = reference.info.height;

const heat = Buffer.alloc(width * height * 3);
const region = Buffer.alloc(width * height * 3);
const signed = Buffer.alloc(width * height * 3);
const rows = {
  all: createStats(),
  pattern: createStats(),
  missed: createStats(),
  extra: createStats(),
};
let psPattern = 0;
let cloudPattern = 0;
let missed = 0;
let extra = 0;

for (let offset = 0; offset < reference.data.length; offset += 3) {
  const diff = pixelDiff(reference.data, cloud.data, offset);
  addStats(rows.all, reference.data, cloud.data, offset);

  const psDiff = pixelDiff(reference.data, base.data, offset);
  const cloudDiff = pixelDiff(cloud.data, base.data, offset);
  const psIsPattern = psDiff > 26 && !isNearWhite(reference.data, offset);
  const cloudIsPattern = cloudDiff > 26 && !isNearWhite(cloud.data, offset);
  if (psIsPattern) {
    psPattern += 1;
    addStats(rows.pattern, reference.data, cloud.data, offset);
  }
  if (cloudIsPattern) {
    cloudPattern += 1;
  }
  if (psIsPattern && !cloudIsPattern) {
    missed += 1;
    addStats(rows.missed, reference.data, cloud.data, offset);
  }
  if (!psIsPattern && cloudIsPattern) {
    extra += 1;
    addStats(rows.extra, reference.data, cloud.data, offset);
  }

  const heatValue = Math.max(0, Math.min(255, Math.round(diff * 6)));
  heat[offset] = heatValue;
  heat[offset + 1] = Math.max(0, 80 - Math.round(diff * 2));
  heat[offset + 2] = 255 - heatValue;

  if (psIsPattern && !cloudIsPattern) {
    region[offset] = 245;
    region[offset + 1] = 50;
    region[offset + 2] = 50;
  } else if (!psIsPattern && cloudIsPattern) {
    region[offset] = 59;
    region[offset + 1] = 130;
    region[offset + 2] = 246;
  } else if (psIsPattern && cloudIsPattern) {
    region[offset] = 34;
    region[offset + 1] = 197;
    region[offset + 2] = 94;
  } else {
    const grey = Math.round((base.data[offset] + base.data[offset + 1] + base.data[offset + 2]) / 3);
    region[offset] = grey;
    region[offset + 1] = grey;
    region[offset + 2] = grey;
  }

  signed[offset] = clampByte(128 + (cloud.data[offset] - reference.data[offset]) * 3);
  signed[offset + 1] = clampByte(128 + (cloud.data[offset + 1] - reference.data[offset + 1]) * 3);
  signed[offset + 2] = clampByte(128 + (cloud.data[offset + 2] - reference.data[offset + 2]) * 3);
}

await writeRaw(sharp, path.join(outputDir, "heat-diff.png"), heat, width, height);
await writeRaw(sharp, path.join(outputDir, "coverage-region.png"), region, width, height);
await writeRaw(sharp, path.join(outputDir, "signed-channel-diff.png"), signed, width, height);

const summary = {
  scene: sceneIndex,
  psPatternPct: pct(psPattern, width * height),
  cloudPatternPct: pct(cloudPattern, width * height),
  missedPct: pct(missed, width * height),
  extraPct: pct(extra, width * height),
  stats: Object.fromEntries(Object.entries(rows).map(([key, value]) => [key, finishStats(value)])),
  files: {
    heat: path.join(outputDir, "heat-diff.png"),
    coverage: path.join(outputDir, "coverage-region.png"),
    signed: path.join(outputDir, "signed-channel-diff.png"),
  },
};
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify(summary, null, 2));

async function readRaw(sharp, inputPath) {
  return sharp(inputPath, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function writeRaw(sharp, outputPath, data, width, height) {
  await sharp(data, {
    raw: {
      width,
      height,
      channels: 3,
    },
  }).png().toFile(outputPath);
}

function pixelDiff(left, right, offset) {
  return (
    Math.abs(left[offset] - right[offset])
    + Math.abs(left[offset + 1] - right[offset + 1])
    + Math.abs(left[offset + 2] - right[offset + 2])
  ) / 3;
}

function isNearWhite(data, offset) {
  const r = data[offset];
  const g = data[offset + 1];
  const b = data[offset + 2];
  return r > 225 && g > 225 && b > 225 && Math.max(r, g, b) - Math.min(r, g, b) < 24;
}

function createStats() {
  return { count: 0, sumAbs: [0, 0, 0], sumSigned: [0, 0, 0] };
}

function addStats(stats, reference, cloud, offset) {
  stats.count += 1;
  for (let channel = 0; channel < 3; channel += 1) {
    const delta = cloud[offset + channel] - reference[offset + channel];
    stats.sumSigned[channel] += delta;
    stats.sumAbs[channel] += Math.abs(delta);
  }
}

function finishStats(stats) {
  return {
    count: stats.count,
    meanAbs: stats.sumAbs.map((value) => Number((value / Math.max(1, stats.count)).toFixed(2))),
    meanSigned: stats.sumSigned.map((value) => Number((value / Math.max(1, stats.count)).toFixed(2))),
  };
}

function pct(value, total) {
  return Number(((value / total) * 100).toFixed(2));
}

function clampByte(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--sku") {
      parsed.sku = values[index + 1] || "";
      index += 1;
    } else if (value === "--scene") {
      parsed.scene = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-dir") {
      parsed.referenceDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--cloud-dir") {
      parsed.cloudDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
