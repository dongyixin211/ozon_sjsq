import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const repoRoot = path.resolve(import.meta.dirname, "..");
const sourcePath = "D:/ozon/商品图/原图/TJ20251116000279.png";
const psDir = "D:/ozon/商品图/套图/TJ20251116000279/images";
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

const sceneIndex = Number(process.argv[2] || 6);
const xValues = (process.argv[3] || "-0.5,-0.375,-0.25,-0.125,0,0.125,0.25,0.375,0.5").split(",").map(Number);
const yValues = (process.argv[4] || process.argv[3] || "-0.5,-0.375,-0.25,-0.125,0,0.125,0.25,0.375,0.5").split(",").map(Number);

process.env.MOCKUP_SCENE_FILTER = String(sceneIndex);
const { default: sharp } = await import(sharpPath);
const { renderFangjinMockups } = await import(`${rendererPath}?scene=${sceneIndex}_${Date.now()}`);
const sourceBuffer = await fs.readFile(sourcePath);
const psPath = path.join(psDir, `111_TJ20251116000279_${String(sceneIndex).padStart(2, "0")}.gif`);
const psDirectBuffer = await sharp(psPath, { animated: false }).toBuffer();
const psBuffer = await sharp(psDirectBuffer).jpeg({ quality: 92 }).toBuffer();
const rows = [];

for (const offsetX of xValues) {
  for (const offsetY of yValues) {
    const rendered = await renderFangjinMockups({
      sourceBuffer,
      sku: "TJ20251116000279",
      perspectivePixelOffsetX: offsetX,
      perspectivePixelOffsetY: offsetY,
    });
    const scene = rendered.scenes.find((item) => item.index === sceneIndex);
    if (!scene) {
      throw new Error(`未找到场景 ${sceneIndex}`);
    }
    rows.push({
      offsetX,
      offsetY,
      mae: Number((await calculateMae(psBuffer, scene.buffer)).toFixed(3)),
      directMae: Number((await calculateMae(psDirectBuffer, scene.buffer)).toFixed(3)),
    });
  }
}

delete process.env.MOCKUP_SCENE_FILTER;

rows.sort((left, right) => left.mae - right.mae);
console.log("按历史 MAE 排序：");
console.table(rows.slice(0, 20));
console.log("按直接 GIF MAE 排序：");
console.table([...rows].sort((left, right) => left.directMae - right.directMae).slice(0, 20));

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
