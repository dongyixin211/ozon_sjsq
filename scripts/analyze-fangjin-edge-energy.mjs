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
]);
const psPath = path.join(psDir, `111_TJ20251116000279_${String(sceneIndex).padStart(2, "0")}.gif`);

const [cloud, ps] = await Promise.all([
  sharp(cloudPath).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
  sharp(psPath, { animated: false }).resize(800, 1067, { fit: "fill" }).removeAlpha().raw().toBuffer({ resolveWithObject: true }),
]);

const regionsByScene = {
  3: [
    { name: "whole", left: 0, top: 0, width: 800, height: 1067 },
    { name: "lion", left: 250, top: 330, width: 320, height: 260 },
    { name: "border", left: 170, top: 500, width: 460, height: 300 },
  ],
  6: [
    { name: "whole", left: 0, top: 0, width: 800, height: 1067 },
    { name: "lion", left: 220, top: 350, width: 360, height: 300 },
    { name: "border", left: 90, top: 230, width: 620, height: 620 },
    { name: "inset", left: 10, top: 690, width: 210, height: 230 },
  ],
};

const regions = regionsByScene[sceneIndex] ?? regionsByScene[6];
console.table(regions.map((region) => {
  const psEnergy = edgeEnergy(ps.data, region);
  const cloudEnergy = edgeEnergy(cloud.data, region);
  return {
    region: region.name,
    ps: Number(psEnergy.toFixed(3)),
    cloud: Number(cloudEnergy.toFixed(3)),
    delta: Number((psEnergy - cloudEnergy).toFixed(3)),
    ratio: Number((cloudEnergy / psEnergy).toFixed(4)),
  };
}));

function edgeEnergy(data, region) {
  let sum = 0;
  let count = 0;
  const right = Math.min(799, region.left + region.width - 1);
  const bottom = Math.min(1066, region.top + region.height - 1);
  for (let y = Math.max(1, region.top); y < bottom; y += 1) {
    for (let x = Math.max(1, region.left); x < right; x += 1) {
      const center = luma(data, x, y);
      const dx = luma(data, x + 1, y) - luma(data, x - 1, y);
      const dy = luma(data, x, y + 1) - luma(data, x, y - 1);
      sum += Math.sqrt(dx * dx + dy * dy) + Math.abs(center - luma(data, x + 1, y + 1)) * 0.25;
      count += 1;
    }
  }
  return sum / count;
}

function luma(data, x, y) {
  const offset = (y * 800 + x) * 3;
  return data[offset] * 0.2126 + data[offset + 1] * 0.7152 + data[offset + 2] * 0.0722;
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
