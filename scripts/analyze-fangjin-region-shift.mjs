import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const compareDir = path.join(repoRoot, "dist", "ps-compare");
const psDir = "D:/ozon/商品图/套图/TJ20251116000279/images";
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;
const { default: sharp } = await import(sharpPath);

const sceneIndex = Number(process.argv[2] || 6);
const regionName = process.argv[3] || "auto";
const maxShift = Number(process.argv[4] || 4);

const regionsByScene = {
  3: {
    auto: { left: 160, top: 300, width: 500, height: 520 },
    lion: { left: 250, top: 330, width: 320, height: 260 },
    border: { left: 170, top: 500, width: 460, height: 300 },
  },
  6: {
    auto: { left: 90, top: 230, width: 620, height: 620 },
    lion: { left: 220, top: 350, width: 360, height: 300 },
    border: { left: 90, top: 230, width: 620, height: 620 },
    inset: { left: 10, top: 690, width: 210, height: 230 },
  },
};

const region = regionsByScene[sceneIndex]?.[regionName] ?? regionsByScene[sceneIndex]?.auto;
if (!region) {
  throw new Error(`未配置场景 ${sceneIndex} 的区域 ${regionName}`);
}

const cloudPath = await firstExistingPath([
  path.join(compareDir, `cloud-${String(sceneIndex).padStart(2, "0")}.png`),
  path.join(compareDir, `cloud-${String(sceneIndex).padStart(2, "0")}.jpg`),
  path.join(compareDir, `baseline-cloud-${String(sceneIndex).padStart(2, "0")}.png`),
  path.join(compareDir, `baseline-cloud-${String(sceneIndex).padStart(2, "0")}.jpg`),
]);
const psPath = path.join(psDir, `111_TJ20251116000279_${String(sceneIndex).padStart(2, "0")}.gif`);

const [cloud, ps] = await Promise.all([
  sharp(cloudPath).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  sharp(psPath, { animated: false }).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
]);

const rows = [];
for (let dy = -maxShift; dy <= maxShift; dy += 1) {
  for (let dx = -maxShift; dx <= maxShift; dx += 1) {
    rows.push({
      dx,
      dy,
      mae: Number(regionMae(ps.data, cloud.data, region, dx, dy).toFixed(3)),
    });
  }
}

rows.sort((left, right) => left.mae - right.mae);
console.table(rows.slice(0, 20));
console.log(JSON.stringify({
  scene: sceneIndex,
  regionName,
  region,
  baseline: rows.find((row) => row.dx === 0 && row.dy === 0),
  best: rows[0],
}, null, 2));

function regionMae(psData, cloudData, region, dx, dy) {
  let sum = 0;
  let count = 0;
  const left = Math.max(region.left, region.left - dx, 0);
  const top = Math.max(region.top, region.top - dy, 0);
  const right = Math.min(region.left + region.width, region.left + region.width - dx, 800);
  const bottom = Math.min(region.top + region.height, region.top + region.height - dy, 1067);
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const psOffset = (y * 800 + x) * 3;
      const cloudOffset = ((y + dy) * 800 + x + dx) * 3;
      sum += (
        Math.abs(psData[psOffset] - cloudData[cloudOffset])
        + Math.abs(psData[psOffset + 1] - cloudData[cloudOffset + 1])
        + Math.abs(psData[psOffset + 2] - cloudData[cloudOffset + 2])
      ) / 3;
      count += 1;
    }
  }
  return sum / count;
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
