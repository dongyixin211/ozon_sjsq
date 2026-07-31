import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const slug = args.slug || "ganfamao";
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, "dist", "mockup-render-check", slug));
const templateRoot = path.resolve(args.templateRoot || path.join(repoRoot, "server", "src", "mockup-templates"));
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

process.env.JWT_SECRET ||= "local-render-preview-secret-123456";
process.env.ADMIN_TOKEN ||= "local-admin-token-123456";
process.env.DATABASE_URL ||= "postgres://preview:preview@127.0.0.1:5432/preview";
process.env.STORAGE_PROVIDER ||= "local";
process.env.STORAGE_BUCKET ||= "local-preview";
process.env.STORAGE_PUBLIC_BASE_URL ||= "http://127.0.0.1:8787";
process.env.MOCKUP_TEMPLATE_ROOT ||= templateRoot;

await fs.mkdir(outputDir, { recursive: true });
const { renderMockupsWithTemplate } = await import(`${rendererPath}?t=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = args.source
  ? await fs.readFile(path.resolve(args.source))
  : await createSource(sharp);

const rendered = await renderMockupsWithTemplate({
  templateDir: slug,
  sourceBuffer,
  sku: "CHECK",
});

const rows = [];
for (const scene of rendered.scenes) {
  const filePath = path.join(outputDir, scene.filename);
  await fs.writeFile(filePath, scene.buffer);
  rows.push({
    scene: scene.index,
    filePath,
    size: scene.buffer.length,
  });
}

const contactSheetPath = path.join(outputDir, "contact-sheet.jpg");
await createContactSheet(sharp, rows.map((row) => row.filePath), contactSheetPath);
console.table(rows);
console.log(contactSheetPath);

async function createSource(sharp) {
  return sharp({
    create: {
      width: 1024,
      height: 1024,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .composite([
      {
        input: Buffer.from(`
          <svg width="1024" height="1024" viewBox="0 0 1024 1024" xmlns="http://www.w3.org/2000/svg">
            <rect width="1024" height="1024" fill="#f8fafc"/>
            <rect x="0" y="0" width="512" height="512" fill="#ef4444"/>
            <rect x="512" y="0" width="512" height="512" fill="#22c55e"/>
            <rect x="0" y="512" width="512" height="512" fill="#3b82f6"/>
            <rect x="512" y="512" width="512" height="512" fill="#f59e0b"/>
            <circle cx="512" cy="512" r="260" fill="rgba(255,255,255,0.72)"/>
            <text x="512" y="545" text-anchor="middle" font-family="Arial, sans-serif" font-size="96" font-weight="700" fill="#111827">SKU</text>
          </svg>
        `),
        left: 0,
        top: 0,
      },
    ])
    .png()
    .toBuffer();
}

async function createContactSheet(sharp, files, outputPath) {
  const width = 280;
  const height = 374;
  const gap = 14;
  const panels = await Promise.all(files.map((file) => sharp(file).resize(width, height, { fit: "contain", background: "#f8fafc" }).jpeg({ quality: 88 }).toBuffer()));
  await sharp({
    create: {
      width: width * panels.length + gap * (panels.length - 1),
      height,
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

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--slug") {
      parsed.slug = values[index + 1] || "";
      index += 1;
    } else if (value === "--source") {
      parsed.source = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--template-root") {
      parsed.templateRoot = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
