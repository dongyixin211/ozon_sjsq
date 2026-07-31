import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const psDir = "D:/ozon/商品图/套图/TJ20251116000279/images";
const compareDir = path.join(repoRoot, "dist", "ps-compare");
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;
const { default: sharp } = await import(sharpPath);
const width = 800;
const height = 1067;

const sceneIndex = Number(process.argv[2] || 6);
const radius = Number(process.argv[3] || 6);
const region = parseRegion(process.argv[4]);
const cloudPath = await firstExistingPath([
  path.join(compareDir, `cloud-${String(sceneIndex).padStart(2, "0")}.jpg`),
  path.join(compareDir, `baseline-cloud-${String(sceneIndex).padStart(2, "0")}.jpg`),
]);
const psPath = path.join(psDir, `111_TJ20251116000279_${String(sceneIndex).padStart(2, "0")}.gif`);

const [cloud, ps] = await Promise.all([
  sharp(cloudPath).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  sharp(psPath, { animated: false }).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
]);

let best = { dx: 0, dy: 0, mae: Number.POSITIVE_INFINITY };
for (let dy = -radius; dy <= radius; dy += 1) {
  for (let dx = -radius; dx <= radius; dx += 1) {
    const mae = calculateMae(dx, dy);
    if (mae < best.mae) {
      best = { dx, dy, mae };
    }
  }
}

console.log(JSON.stringify({
  scene: sceneIndex,
  radius,
  region,
  best: { ...best, mae: Number(best.mae.toFixed(3)) },
  current: Number(calculateMae(0, 0).toFixed(3)),
}, null, 2));

function calculateMae(dx, dy) {
  let sum = 0;
  let count = 0;
  const left = Math.max(region.left, region.left - dx, 0);
  const top = Math.max(region.top, region.top - dy, 0);
  const right = Math.min(region.left + region.width, region.left + region.width - dx, width);
  const bottom = Math.min(region.top + region.height, region.top + region.height - dy, height);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const psOffset = (y * width + x) * 3;
      const cloudOffset = ((y + dy) * width + (x + dx)) * 3;
      sum += (
        Math.abs(ps.data[psOffset] - cloud.data[cloudOffset])
        + Math.abs(ps.data[psOffset + 1] - cloud.data[cloudOffset + 1])
        + Math.abs(ps.data[psOffset + 2] - cloud.data[cloudOffset + 2])
      ) / 3;
      count += 1;
    }
  }
  return sum / count;
}

function parseRegion(value) {
  if (!value) {
    return { left: 0, top: 0, width, height };
  }
  const [left, top, regionWidth, regionHeight] = value.split(",").map(Number);
  return {
    left: Math.max(0, Math.min(width - 1, left)),
    top: Math.max(0, Math.min(height - 1, top)),
    width: Math.max(1, Math.min(width - left, regionWidth)),
    height: Math.max(1, Math.min(height - top, regionHeight)),
  };
}

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
