import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-scene7-source-scan"));
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT ||= path.join(repoRoot, "server", "src", "mockup-templates");

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(outputDir, { recursive: true });

const { renderMockupsWithTemplate } = await import(`${rendererPath}?scene7SourceScan=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_07.gif`));
const candidates = createCandidates();
const summaries = [];

for (const candidate of candidates) {
  const prepared = await prepareSource(sharp, sourceBuffer, candidate);
  const rendered = await renderMockupsWithTemplate({
    templateDir: "zhuobu",
    sourceBuffer: prepared,
    sku,
    sceneIndexes: [7],
  });
  const cloudBuffer = rendered.scenes[0].buffer;
  const cloudPath = path.join(outputDir, `${candidate.label}-cloud-07.png`);
  if (candidate.keepImage) {
    await fs.writeFile(cloudPath, cloudBuffer);
  }
  const metric = await calculateMae(sharp, referenceBuffer, cloudBuffer);
  const summary = {
    ...candidate,
    similarity: metric.similarity,
    mae: metric.mae,
    cloudPath: candidate.keepImage ? cloudPath : "",
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    label: candidate.label,
    similarity: summary.similarity,
  }));
}

summaries.sort((left, right) => right.similarity - left.similarity);
for (const item of summaries.slice(0, 10)) {
  if (!item.cloudPath) {
    const prepared = await prepareSource(sharp, sourceBuffer, { ...item, keepImage: true });
    const rendered = await renderMockupsWithTemplate({
      templateDir: "zhuobu",
      sourceBuffer: prepared,
      sku,
      sceneIndexes: [7],
    });
    item.cloudPath = path.join(outputDir, `${item.label}-cloud-07.png`);
    await fs.writeFile(item.cloudPath, rendered.scenes[0].buffer);
  }
}
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
await createComparison(sharp, summaries.slice(0, 10), referenceBuffer, outputDir);

console.table(summaries.slice(0, 20).map((item) => ({
  label: item.label,
  similarity: item.similarity,
  scaleX: item.scaleX,
  scaleY: item.scaleY,
  offsetX: item.offsetX,
  offsetY: item.offsetY,
})));
console.log(path.join(outputDir, "summary.json"));
console.log(path.join(outputDir, "scene-07-source-candidates.jpg"));

function createCandidates() {
  const output = [{ label: "baseline", scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0, keepImage: true }];
  for (const scaleX of [0.92, 0.96, 1.04, 1.08]) {
    output.push({ label: `sx${slug(scaleX)}`, scaleX, scaleY: 1, offsetX: 0, offsetY: 0 });
  }
  for (const scaleY of [0.88, 0.94, 1.06, 1.12]) {
    output.push({ label: `sy${slug(scaleY)}`, scaleX: 1, scaleY, offsetX: 0, offsetY: 0 });
  }
  for (const offsetX of [-160, -80, -40, 40, 80, 160]) {
    output.push({ label: `x${slug(offsetX)}`, scaleX: 1, scaleY: 1, offsetX, offsetY: 0 });
  }
  for (const offsetY of [-160, -80, -40, 40, 80, 160]) {
    output.push({ label: `y${slug(offsetY)}`, scaleX: 1, scaleY: 1, offsetX: 0, offsetY });
  }
  for (const scaleX of [0.96, 1.04]) {
    for (const offsetY of [-80, 80]) {
      output.push({ label: `sx${slug(scaleX)}-y${slug(offsetY)}`, scaleX, scaleY: 1, offsetX: 0, offsetY });
    }
  }
  for (const scaleY of [0.94, 1.06]) {
    for (const offsetX of [-80, 80]) {
      output.push({ label: `sy${slug(scaleY)}-x${slug(offsetX)}`, scaleX: 1, scaleY, offsetX, offsetY: 0 });
    }
  }
  return output;
}

async function prepareSource(sharp, sourceBuffer, candidate) {
  const baseWidth = 1600;
  const baseHeight = 960;
  const width = Math.round(baseWidth * (candidate.scaleX ?? 1));
  const height = Math.round(baseHeight * (candidate.scaleY ?? 1));
  const image = await sharp(sourceBuffer)
    .resize({ width, height, fit: "fill", kernel: "lanczos3" })
    .png()
    .toBuffer();
  const offsetX = Math.round(candidate.offsetX ?? 0);
  const offsetY = Math.round(candidate.offsetY ?? 0);
  const marginX = Math.abs(offsetX) + Math.max(0, width - baseWidth) + 8;
  const marginY = Math.abs(offsetY) + Math.max(0, height - baseHeight) + 8;
  const canvasWidth = baseWidth + marginX * 2;
  const canvasHeight = baseHeight + marginY * 2;
  const left = Math.round((canvasWidth - width) / 2 + offsetX);
  const top = Math.round((canvasHeight - height) / 2 + offsetY);
  const composed = await sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: image, left, top }])
    .png()
    .toBuffer();
  return sharp(composed)
    .extract({
      left: Math.round((canvasWidth - baseWidth) / 2),
      top: Math.round((canvasHeight - baseHeight) / 2),
      width: baseWidth,
      height: baseHeight,
    })
    .png()
    .toBuffer();
}

async function calculateMae(sharp, referenceBuffer, cloudBuffer) {
  const reference = await rawRgb(sharp, referenceBuffer);
  const cloud = await rawRgb(sharp, cloudBuffer);
  let sum = 0;
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    sum += (
      Math.abs(reference.data[offset] - cloud.data[offset])
      + Math.abs(reference.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(reference.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
  }
  const mae = sum / (reference.data.length / 3);
  return {
    mae: Number(mae.toFixed(3)),
    similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
  };
}

async function rawRgb(sharp, buffer) {
  return sharp(buffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function createComparison(sharp, summaries, referenceBuffer, outputDir) {
  const panels = [await labelPanel(sharp, referenceBuffer, "PS")];
  for (const summary of summaries) {
    panels.push(await labelPanel(sharp, await fs.readFile(summary.cloudPath), `${summary.label} ${summary.similarity}%`));
  }
  await sharp({
    create: {
      width: panels.length * 260 + (panels.length - 1) * 10,
      height: 391,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({ input, left: index * 270, top: 0 })))
    .jpeg({ quality: 90 })
    .toFile(path.join(outputDir, "scene-07-source-candidates.jpg"));
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false }).resize({ width: 260, height: 347, fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="260" height="44"><rect width="260" height="44" fill="#111827"/><text x="8" y="28" font-family="Arial" font-size="14" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 260, height: 391, channels: 3, background: "#fff" } })
    .composite([{ input: svg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function slug(value) {
  return String(value).replace("-", "m").replace(".", "p");
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
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
