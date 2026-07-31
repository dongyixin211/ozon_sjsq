import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const psDir = "D:/ozon/商品图/套图/TJ20251116000279/images";
const compareDir = path.join(repoRoot, "dist", "ps-compare");
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

const [cloud, ps] = await Promise.all([
  sharp(cloudPath).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  sharp(psPath, { animated: false }).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
]);

const regions = [
  { name: "red", left: 160, top: 285, width: 500, height: 90 },
  { name: "yellow", left: 160, top: 430, width: 500, height: 90 },
  { name: "green", left: 160, top: 610, width: 500, height: 90 },
  { name: "black-lion", left: 270, top: 360, width: 260, height: 250 },
  { name: "border", left: 110, top: 230, width: 580, height: 90 },
];

const rows = regions.map((region) => {
  const psMean = meanColor(ps.data, region);
  const cloudMean = meanColor(cloud.data, region);
  return {
    region: region.name,
    ps: psMean,
    cloud: cloudMean,
    delta: psMean.map((value, index) => Number((value - cloudMean[index]).toFixed(2))),
  };
});

console.table(rows);

function meanColor(data, region) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = region.top; y < region.top + region.height; y += 1) {
    for (let x = region.left; x < region.left + region.width; x += 1) {
      const offset = (y * 800 + x) * 3;
      r += data[offset];
      g += data[offset + 1];
      b += data[offset + 2];
      count += 1;
    }
  }
  return [r / count, g / count, b / count].map((value) => Number(value.toFixed(2)));
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
