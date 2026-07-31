import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(repoRoot, "dist", "mockup-render-check", "ganfamao-scene1-layers-debug");
const templateRoot = path.join(outputDir, "templates");
const sourcePath = "D:/ozon/\u5546\u54c1\u56fe/\u5e72\u53d1\u5e3d/\u539f\u56fe/TJ20251116000279.png";
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
await fs.cp(path.join(repoRoot, "server", "src", "mockup-templates", "ganfamao"), path.join(templateRoot, "ganfamao"), { recursive: true });

const templatePath = path.join(templateRoot, "ganfamao", "template.json");
const baseTemplate = JSON.parse(await fs.readFile(templatePath, "utf8"));
const baseScene = baseTemplate.scenes.find((scene) => scene.index === 1);
const baseLayer = baseScene.layers.find((layer) => layer.kind === "image" && layer.name === "1");
const replacements = baseScene.layers.filter((layer) => layer.kind === "replace");
const linearLight = baseScene.layers.find((layer) => layer.blendMode === "linear_light");

const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?debugScene1=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const renderedFiles = [];

for (const [index, replacement] of replacements.entries()) {
  for (const maskMode of ["original", "full"]) {
    const template = structuredClone(baseTemplate);
    const scene = template.scenes.find((item) => item.index === 1);
    const layer = structuredClone(replacement);
    layer.order = 1;
    if (maskMode === "full") {
      layer.clipMask = "masks/scene-01-replace-007.png";
      layer.clipMaskLeft = 0;
      layer.clipMaskTop = 0;
      layer.clipMaskWidth = 800;
      layer.clipMaskHeight = 1067;
      layer.clipBaseName = "full";
    }
    scene.layers = [
      { ...baseLayer, order: 0 },
      layer,
      ...(linearLight ? [{ ...linearLight, order: 2 }] : []),
    ];
    template.scenes = [scene];
    await fs.writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
    invalidateMockupTemplateCache("ganfamao");
    const rendered = await renderMockupsWithTemplate({
      templateDir: "ganfamao",
      sourceBuffer,
      sku: `L${index + 1}-${maskMode}`,
      sceneIndexes: [1],
    });
    const outputPath = path.join(outputDir, `layer-${index + 1}-${maskMode}.png`);
    await fs.writeFile(outputPath, rendered.scenes[0].buffer);
    renderedFiles.push({
      label: `${index + 1} ${maskMode}`,
      file: outputPath,
    });
  }
}

await createContactSheet(sharp, renderedFiles, path.join(outputDir, "contact-sheet.jpg"));
console.log(path.join(outputDir, "contact-sheet.jpg"));

async function createContactSheet(sharp, rows, outputPath) {
  const width = 240;
  const height = 320;
  const labelHeight = 38;
  const gap = 10;
  const panels = await Promise.all(rows.map(async (row) => {
    const image = await sharp(row.file)
      .resize(width, height, { fit: "contain", background: "#f8fafc" })
      .jpeg({ quality: 88 })
      .toBuffer();
    const label = Buffer.from(`
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${labelHeight}">
        <rect width="100%" height="100%" fill="#111827"/>
        <text x="10" y="25" font-family="Arial, sans-serif" font-size="16" fill="#ffffff">${row.label}</text>
      </svg>
    `);
    return sharp({
      create: {
        width,
        height: height + labelHeight,
        channels: 3,
        background: "#ffffff",
      },
    })
      .composite([
        { input: label, left: 0, top: 0 },
        { input: image, left: 0, top: labelHeight },
      ])
      .jpeg({ quality: 90 })
      .toBuffer();
  }));
  await sharp({
    create: {
      width: panels.length * width + (panels.length - 1) * gap,
      height: height + labelHeight,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({
      input,
      left: index * (width + gap),
      top: 0,
    })))
    .jpeg({ quality: 90 })
    .toFile(outputPath);
}
