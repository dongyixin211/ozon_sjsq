import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "huazhuangbao-current-diff"));
const sourcePath = path.resolve(args.source || path.join(repoRoot, ".codex-work", "inputs", "lion.png"));
const referenceDir = path.resolve(args.referenceDir || path.join(repoRoot, ".codex-work", "mockup-ps-direct", "huazhuangbao-lion"));
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
const { renderMockupsWithTemplate } = await import(`${rendererPath}?huazhuangbaoCompare=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const sourceBuffer = await fs.readFile(sourcePath);
const rendered = await renderMockupsWithTemplate({
  templateDir: "huazhuangbao",
  sourceBuffer,
  sku: path.basename(sourcePath, path.extname(sourcePath)),
});

const metrics = [];
const panels = [];
for (const scene of rendered.scenes) {
  const localPath = path.join(outputDir, `local-${String(scene.index).padStart(2, "0")}.png`);
  await fs.writeFile(localPath, scene.buffer);

  const referencePath = path.join(referenceDir, `ps-direct-${String(scene.index).padStart(2, "0")}.jpg`);
  const referenceBuffer = await fs.readFile(referencePath);
  const stats = await calculateStats(sharp, referenceBuffer, scene.buffer);
  const diffPath = path.join(outputDir, `diff-${String(scene.index).padStart(2, "0")}.png`);
  await sharp(stats.diff, {
    raw: { width: stats.width, height: stats.height, channels: 3 },
  }).png().toFile(diffPath);

  metrics.push({
    scene: scene.index,
    mae: Number(stats.mae.toFixed(3)),
    max: stats.max,
    over10: Number(stats.over10.toFixed(2)),
    over25: Number(stats.over25.toFixed(2)),
    localPath,
    referencePath,
  });
  panels.push(await createCompareRow(sharp, referenceBuffer, scene.buffer, await fs.readFile(diffPath), metrics.at(-1)));
}

const comparePath = path.join(outputDir, "contact-ps-local-diff.jpg");
await sharp({
  create: {
    width: 260 * 3,
    height: panels.length * 375,
    channels: 3,
    background: "#ffffff",
  },
})
  .composite(panels.map((input, index) => ({
    input,
    left: 0,
    top: index * 375,
  })))
  .jpeg({ quality: 90 })
  .toFile(comparePath);

await fs.writeFile(path.join(outputDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

const averageMae = metrics.reduce((sum, item) => sum + item.mae, 0) / Math.max(1, metrics.length);
console.table(metrics.map((item) => ({
  scene: item.scene,
  mae: item.mae,
  max: item.max,
  over10: item.over10,
  over25: item.over25,
})));
console.log(`average mae: ${averageMae.toFixed(3)}`);
console.log(comparePath);

async function calculateStats(sharp, referenceBuffer, localBuffer) {
  const reference = await sharp(referenceBuffer, { animated: false })
    .resize(1086, 1448, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const local = await sharp(localBuffer)
    .resize(1086, 1448, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let sum = 0;
  let over10 = 0;
  let over25 = 0;
  let max = 0;
  const diff = Buffer.alloc(reference.data.length);
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    const red = Math.abs(reference.data[offset] - local.data[offset]);
    const green = Math.abs(reference.data[offset + 1] - local.data[offset + 1]);
    const blue = Math.abs(reference.data[offset + 2] - local.data[offset + 2]);
    const pixelDiff = (red + green + blue) / 3;
    sum += pixelDiff;
    if (pixelDiff > 10) over10 += 1;
    if (pixelDiff > 25) over25 += 1;
    max = Math.max(max, red, green, blue);
    diff[offset] = Math.min(255, red * 5);
    diff[offset + 1] = Math.min(255, green * 5);
    diff[offset + 2] = Math.min(255, blue * 5);
  }

  const pixels = reference.info.width * reference.info.height;
  return {
    mae: sum / pixels,
    max,
    over10: (over10 / pixels) * 100,
    over25: (over25 / pixels) * 100,
    width: reference.info.width,
    height: reference.info.height,
    diff,
  };
}

async function createCompareRow(sharp, referenceBuffer, localBuffer, diffBuffer, metric) {
  const referencePanel = await labelPanel(sharp, referenceBuffer, "PS");
  const localPanel = await labelPanel(sharp, localBuffer, `local mae ${metric.mae}`);
  const diffPanel = await labelPanel(sharp, diffBuffer, "diff x5");
  return sharp({
    create: {
      width: 260 * 3,
      height: 375,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      { input: referencePanel, left: 0, top: 0 },
      { input: localPanel, left: 260, top: 0 },
      { input: diffPanel, left: 520, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false })
    .resize(260, 347, { fit: "fill" })
    .jpeg({ quality: 88 })
    .toBuffer();
  const labelSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="260" height="28">
      <rect width="260" height="28" fill="#ffffff"/>
      <text x="8" y="19" font-family="Arial, sans-serif" font-size="16" fill="#111827">${escapeXml(label)}</text>
    </svg>
  `);
  return sharp({
    create: {
      width: 260,
      height: 375,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      { input: labelSvg, left: 0, top: 0 },
      { input: image, left: 0, top: 28 },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}

function escapeXml(value) {
  return String(value)
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
