import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(repoRoot, "dist", "ps-compare");
const sourcePath = "D:/ozon/商品图/原图/TJ20251116000279.png";
const psDir = "D:/ozon/商品图/套图/TJ20251116000279/images";
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

await fs.mkdir(outputDir, { recursive: true });

const { renderFangjinMockups } = await import(rendererPath);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const rendered = await renderFangjinMockups({
  sourceBuffer,
  sku: "TJ20251116000279",
});

const rows = [];
const metrics = [];
for (const scene of rendered.scenes) {
  const cloudPath = path.join(outputDir, `cloud-${String(scene.index).padStart(2, "0")}${path.extname(scene.filename) || ".jpg"}`);
  await fs.writeFile(cloudPath, scene.buffer);

  const psPath = path.join(psDir, `111_TJ20251116000279_${String(scene.index).padStart(2, "0")}.gif`);
  const psDirectBuffer = await sharp(psPath, { animated: false }).toBuffer();
  const psBuffer = await sharp(psDirectBuffer).jpeg({ quality: 92 }).toBuffer();
  const psJpgPath = path.join(outputDir, `ps-${String(scene.index).padStart(2, "0")}.jpg`);
  await fs.writeFile(psJpgPath, psBuffer);
  const mae = await calculateMae(psBuffer, scene.buffer);
  const directMae = await calculateMae(psDirectBuffer, scene.buffer);
  metrics.push({
    scene: scene.index,
    mae: Number(mae.toFixed(3)),
    directMae: Number(directMae.toFixed(3)),
  });

  const psPanel = await labelPanel(psBuffer, `PS ${scene.index}`);
  const cloudPanel = await labelPanel(scene.buffer, `Cloud ${scene.index}`);
  const row = await sharp({
    create: {
      width: 800 * 2 + 24,
      height: 1067 + 44,
      channels: 3,
      background: "#f5f5f5",
    },
  })
    .composite([
      { input: psPanel, left: 0, top: 0 },
      { input: cloudPanel, left: 824, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
  rows.push(row);
}

const comparePath = path.join(outputDir, "ps-vs-cloud-latest.jpg");
await sharp({
  create: {
    width: 800 * 2 + 24,
    height: rows.length * (1067 + 44) + (rows.length - 1) * 24,
    channels: 3,
    background: "#ffffff",
  },
})
  .composite(rows.map((input, index) => ({
    input,
    left: 0,
    top: index * (1067 + 44 + 24),
  })))
  .jpeg({ quality: 90 })
  .toFile(comparePath);

const averageMae = metrics.reduce((sum, item) => sum + item.mae, 0) / metrics.length;
const averageDirectMae = metrics.reduce((sum, item) => sum + item.directMae, 0) / metrics.length;
console.table(metrics);
console.log(`average mae: ${averageMae.toFixed(3)}`);
console.log(`average direct mae: ${averageDirectMae.toFixed(3)}`);
console.log(comparePath);

async function calculateMae(psBuffer, cloudBuffer) {
  const ps = await sharp(psBuffer)
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
  for (let offset = 0; offset < ps.data.length; offset += 3) {
    sum += (
      Math.abs(ps.data[offset] - cloud.data[offset])
      + Math.abs(ps.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(ps.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
  }
  return sum / (ps.data.length / 3);
}

async function labelPanel(buffer, label) {
  const image = await sharp(buffer)
    .resize({ width: 800, height: 1067, fit: "fill" })
    .jpeg({ quality: 92 })
    .toBuffer();
  const labelSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="44">
      <rect width="800" height="44" fill="#111827"/>
      <text x="18" y="29" font-family="Arial, sans-serif" font-size="22" fill="#ffffff">${escapeXml(label)}</text>
    </svg>
  `);
  return sharp({
    create: {
      width: 800,
      height: 1111,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      { input: labelSvg, left: 0, top: 0 },
      { input: image, left: 0, top: 44 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
