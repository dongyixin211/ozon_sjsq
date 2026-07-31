import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-scene-coverage");
const sourcePath = path.resolve("D:/ozon/\u5546\u54c1\u56fe/\u684c\u5e03/\u539f\u56fe/TM20251026002593.png");
const referenceDir = path.resolve("D:/ozon/\u5546\u54c1\u56fe/\u684c\u5e03/\u5957\u56fe/TM20251026002593/images");
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT ||= path.join(repoRoot, "server", "src", "mockup-templates");
process.env.MOCKUP_SCENE_FILTER = process.env.MOCKUP_SCENE_FILTER || "1";

await fs.mkdir(outputDir, { recursive: true });
const { default: sharp } = await import(sharpPath);
const { renderMockupsWithTemplate } = await import(`${rendererPath}?coverage=${Date.now()}`);

const sourceBuffer = await fs.readFile(sourcePath);
const rendered = await renderMockupsWithTemplate({
  templateDir: "zhuobu",
  sourceBuffer,
  sku: "TM20251026002593",
});
const scene = rendered.scenes[0];
const cloudPath = path.join(outputDir, "scene-01-cloud.png");
await fs.writeFile(cloudPath, scene.buffer);

const referencePath = path.join(referenceDir, "111_TM20251026002593_01.gif");
const referenceBuffer = await fs.readFile(referencePath);
const referencePng = await sharp(referenceBuffer, { animated: false }).resize(800, 1067, { fit: "fill" }).png().toBuffer();
const referencePathOut = path.join(outputDir, "scene-01-ps.png");
await fs.writeFile(referencePathOut, referencePng);

const layersDir = path.join(repoRoot, "server", "src", "mockup-templates", "zhuobu", "layers");
const maskBuffer = await sharp(path.join(layersDir, "scene-01-layer-004.png"))
  .resize(800, 1067, { fit: "fill" })
  .ensureAlpha()
  .extractChannel("alpha")
  .png()
  .toBuffer();
const maskOverlay = await tintMask(sharp, maskBuffer, "#00a3ff");
await fs.writeFile(path.join(outputDir, "scene-01-mask-alpha.png"), maskOverlay);

const shadowBuffer = await sharp(path.join(layersDir, "scene-01-layer-000.png"))
  .resize(800, 1067, { fit: "fill" })
  .png()
  .toBuffer();
await fs.writeFile(path.join(outputDir, "scene-01-linear-light-layer.png"), shadowBuffer);

const compare = await sharp({
  create: {
    width: 800 * 4 + 24 * 3,
    height: 1067 + 44,
    channels: 3,
    background: "#ffffff",
  },
})
  .composite([
    { input: await panel(sharp, referencePng, "PS reference"), left: 0, top: 0 },
    { input: await panel(sharp, scene.buffer, "cloud"), left: 824, top: 0 },
    { input: await panel(sharp, maskOverlay, "cloth mask alpha"), left: 1648, top: 0 },
    { input: await panel(sharp, shadowBuffer, "linear light"), left: 2472, top: 0 },
  ])
  .jpeg({ quality: 90 })
  .toBuffer();
await fs.writeFile(path.join(outputDir, "scene-01-debug.jpg"), compare);
console.log(path.join(outputDir, "scene-01-debug.jpg"));

async function tintMask(sharp, maskBuffer, color) {
  const meta = await sharp(maskBuffer).metadata();
  const tint = await sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${meta.width}" height="${meta.height}"><rect width="100%" height="100%" fill="${color}"/></svg>`))
    .ensureAlpha()
    .toBuffer();
  const base = await sharp({
    create: {
      width: meta.width,
      height: meta.height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([{ input: tint, left: 0, top: 0, blend: "over" }])
    .png()
    .toBuffer();
  return sharp(base)
    .joinChannel(maskBuffer)
    .png()
    .toBuffer();
}

async function panel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false }).resize(800, 1067, { fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const labelSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="800" height="44"><rect width="800" height="44" fill="#111827"/><text x="18" y="29" font-family="Arial" font-size="22" fill="#fff">${label}</text></svg>`);
  return sharp({
    create: {
      width: 800,
      height: 1111,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([{ input: labelSvg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}
