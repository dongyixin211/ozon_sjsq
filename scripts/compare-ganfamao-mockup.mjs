import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, "dist", "mockup-render-check", "ganfamao-compare"));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/干发帽/原图/TJ20251116000279.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/干发帽/套图/TJ20251116000279");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT ||= path.join(repoRoot, "server", "src", "mockup-templates");

await fs.mkdir(outputDir, { recursive: true });
const { renderMockupsWithTemplate } = await import(`${rendererPath}?ganfamaoCompare=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const rendered = await renderMockupsWithTemplate({
  templateDir: "ganfamao",
  sourceBuffer,
  sku,
});

const metrics = [];
const panels = [];
for (const scene of rendered.scenes) {
  const cloudPath = path.join(outputDir, `cloud-${String(scene.index).padStart(2, "0")}.png`);
  await fs.writeFile(cloudPath, scene.buffer);

  const referencePath = path.join(referenceDir, `111_${sku}_${String(scene.index).padStart(2, "0")}.jpg`);
  const referenceBuffer = await fs.readFile(referencePath);
  const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
  const similarity = Math.max(0, 100 - (mae / 255) * 100);
  metrics.push({
    scene: scene.index,
    mae: Number(mae.toFixed(3)),
    similarity: Number(similarity.toFixed(2)),
    cloudPath,
    referencePath,
  });
  panels.push(await createCompareRow(sharp, referenceBuffer, scene.buffer, `scene ${scene.index}`));
}

const comparePath = path.join(outputDir, "ps-vs-cloud.jpg");
await sharp({
  create: {
    width: 800 * 2 + 24,
    height: panels.length * (1067 + 44) + (panels.length - 1) * 24,
    channels: 3,
    background: "#ffffff",
  },
})
  .composite(panels.map((input, index) => ({
    input,
    left: 0,
    top: index * (1067 + 44 + 24),
  })))
  .jpeg({ quality: 90 })
  .toFile(comparePath);

const averageMae = metrics.reduce((sum, item) => sum + item.mae, 0) / Math.max(1, metrics.length);
const averageSimilarity = metrics.reduce((sum, item) => sum + item.similarity, 0) / Math.max(1, metrics.length);
console.table(metrics.map((item) => ({
  scene: item.scene,
  mae: item.mae,
  similarity: item.similarity,
})));
console.log(`average mae: ${averageMae.toFixed(3)}`);
console.log(`average similarity: ${averageSimilarity.toFixed(2)}%`);
console.log(comparePath);

async function calculateMae(sharp, referenceBuffer, cloudBuffer) {
  const reference = await sharp(referenceBuffer)
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
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    sum += (
      Math.abs(reference.data[offset] - cloud.data[offset])
      + Math.abs(reference.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(reference.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
  }
  return sum / (reference.data.length / 3);
}

async function createCompareRow(sharp, referenceBuffer, cloudBuffer, label) {
  const referencePanel = await labelPanel(sharp, referenceBuffer, "PS");
  const cloudPanel = await labelPanel(sharp, cloudBuffer, label);
  return sharp({
    create: {
      width: 800 * 2 + 24,
      height: 1067 + 44,
      channels: 3,
      background: "#f5f5f5",
    },
  })
    .composite([
      { input: referencePanel, left: 0, top: 0 },
      { input: cloudPanel, left: 824, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function labelPanel(sharp, buffer, label) {
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

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--source") {
      parsed.source = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-dir") {
      parsed.referenceDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
