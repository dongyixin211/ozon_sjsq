import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const compareDir = path.join(repoRoot, "dist", "ps-compare");
const psDir = "D:/ozon/商品图/套图/TJ20251116000279/images";
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;
const { default: sharp } = await import(sharpPath);

const sceneIndex = Number(process.argv[2] || 6);
const cloudPath = await firstExistingPath([
  path.join(compareDir, `cloud-${String(sceneIndex).padStart(2, "0")}.png`),
  path.join(compareDir, `cloud-${String(sceneIndex).padStart(2, "0")}.jpg`),
  path.join(compareDir, `baseline-cloud-${String(sceneIndex).padStart(2, "0")}.png`),
  path.join(compareDir, `baseline-cloud-${String(sceneIndex).padStart(2, "0")}.jpg`),
]);
const psPath = path.join(psDir, `111_TJ20251116000279_${String(sceneIndex).padStart(2, "0")}.gif`);
const outputPath = path.join(compareDir, `diff-scene-${String(sceneIndex).padStart(2, "0")}.png`);

const [cloud, ps] = await Promise.all([
  sharp(cloudPath).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  sharp(psPath, { animated: false }).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
]);

const width = 800;
const height = 1067;
const diff = Buffer.alloc(width * height * 3);
const buckets = Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, col) => ({
  row,
  col,
  sum: 0,
  count: 0,
  max: 0,
})));
let sum = 0;
let count = 0;
let max = 0;
let maxAt = { x: 0, y: 0 };

for (let y = 0; y < height; y += 1) {
  for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 3;
    const d = (
      Math.abs(ps.data[offset] - cloud.data[offset])
      + Math.abs(ps.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(ps.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
    sum += d;
    count += 1;
    if (d > max) {
      max = d;
      maxAt = { x, y };
    }
    const heat = Math.max(0, Math.min(255, Math.round(d * 12)));
    diff[offset] = heat;
    diff[offset + 1] = Math.max(0, Math.round(heat * 0.25));
    diff[offset + 2] = 255 - heat;
    const bucket = buckets[Math.min(3, Math.floor((y / height) * 4))][Math.min(3, Math.floor((x / width) * 4))];
    bucket.sum += d;
    bucket.count += 1;
    bucket.max = Math.max(bucket.max, d);
  }
}

await sharp(diff, { raw: { width, height, channels: 3 } })
  .png()
  .toFile(outputPath);

const grid = buckets.flat().map((bucket) => ({
  row: bucket.row,
  col: bucket.col,
  mae: Number((bucket.sum / bucket.count).toFixed(3)),
  max: Number(bucket.max.toFixed(1)),
})).sort((left, right) => right.mae - left.mae);

console.log(JSON.stringify({
  scene: sceneIndex,
  mae: Number((sum / count).toFixed(3)),
  max: Number(max.toFixed(1)),
  maxAt,
  hottestBuckets: grid.slice(0, 8),
  outputPath,
}, null, 2));

async function firstExistingPath(candidates) {
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return candidates[0];
}
