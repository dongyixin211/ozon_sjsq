import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-maskfile-single"));
const exportSceneDir = path.resolve(args.exportSceneDir || path.join(repoRoot, "dist", "mockup-scene-diagnose", "zhuobu-mask-export-v2", "scene-02"));
const templateRoot = path.join(outputDir, "templates");
const slug = "zhuobu-mask-scene2";
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT = templateRoot;

await fs.rm(outputDir, { recursive: true, force: true });
await fs.mkdir(templateRoot, { recursive: true });

const baseDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu");
const targetDir = path.join(templateRoot, slug);
await fs.cp(baseDir, targetDir, { recursive: true });
await fs.mkdir(path.join(targetDir, "masks"), { recursive: true });
await fs.copyFile(path.join(exportSceneDir, "masks", "scene-02-replace-001.png"), path.join(targetDir, "masks", "scene-02-replace-001.png"));
await fs.copyFile(path.join(exportSceneDir, "masks", "scene-02-replace-003.png"), path.join(targetDir, "masks", "scene-02-replace-003.png"));

const templatePath = path.join(targetDir, "template.json");
const template = JSON.parse(await fs.readFile(templatePath, "utf8"));
const scene2 = template.scenes.find((scene) => scene.index === 2);
const replaceLayers = scene2.layers.filter((layer) => layer.kind === "replace").sort((left, right) => left.order - right.order);
replaceLayers[0].mask = undefined;
replaceLayers[0].clipMask = "masks/scene-02-replace-003.png";
replaceLayers[0].clipMaskLeft = 0;
replaceLayers[0].clipMaskTop = 0;
replaceLayers[0].clipMaskWidth = 800;
replaceLayers[0].clipMaskHeight = 1067;
replaceLayers[1].mask = undefined;
replaceLayers[1].clipMask = "masks/scene-02-replace-001.png";
replaceLayers[1].clipMaskLeft = 0;
replaceLayers[1].clipMaskTop = 0;
replaceLayers[1].clipMaskWidth = 800;
replaceLayers[1].clipMaskHeight = 1067;
await fs.writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");

const { renderMockupsWithTemplate } = await import(`${rendererPath}?maskfile=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const rendered = await renderMockupsWithTemplate({ templateDir: slug, sourceBuffer, sku, sceneIndexes: [2] });
const scene = rendered.scenes[0];
const outputPath = path.join(outputDir, "scene-02-maskfile.png");
await fs.writeFile(outputPath, scene.buffer);
const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_02.gif`));
const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
const similarity = Number((100 - (mae / 255) * 100).toFixed(2));
await sharp({
  create: { width: 1624, height: 1111, channels: 3, background: "#ffffff" },
})
  .composite([
    { input: await labelPanel(sharp, referenceBuffer, "PS reference"), left: 0, top: 0 },
    { input: await labelPanel(sharp, scene.buffer, `maskfile ${similarity}%`), left: 824, top: 0 },
  ])
  .jpeg({ quality: 90 })
  .toFile(path.join(outputDir, "scene-02-compare.jpg"));

console.log(JSON.stringify({ outputPath, similarity, mae: Number(mae.toFixed(3)) }, null, 2));

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
  return sum / (reference.data.length / 3);
}

async function rawRgb(sharp, buffer) {
  return sharp(buffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false }).resize(800, 1067, { fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const labelSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="44"><rect width="800" height="44" fill="#111827"/><text x="18" y="29" font-family="Arial" font-size="22" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 800, height: 1111, channels: 3, background: "#fff" } })
    .composite([{ input: labelSvg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
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
    } else if (value === "--export-scene-dir") {
      parsed.exportSceneDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
