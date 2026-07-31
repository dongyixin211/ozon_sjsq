import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-replace-coverage");
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
const { renderMockupsWithTemplate } = await import(`${rendererPath}?coverage=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const sourceBuffer = await sharp({
  create: {
    width: 1600,
    height: 960,
    channels: 3,
    background: { r: 30, g: 120, b: 255 },
  },
})
  .png()
  .toBuffer();

const rendered = await renderMockupsWithTemplate({
  templateDir: "zhuobu",
  sourceBuffer,
  sku: "coverage",
});

for (const scene of rendered.scenes) {
  await fs.writeFile(path.join(outputDir, `scene-${String(scene.index).padStart(2, "0")}.png`), scene.buffer);
}
console.log(outputDir);
