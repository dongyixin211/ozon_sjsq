import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, "dist", "mockup-uv", "zhuobu"));
const width = Number(args.width || 1600);
const height = Number(args.height || 960);
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

await fs.mkdir(outputDir, { recursive: true });
const { default: sharp } = await import(sharpPath);

await createMap(path.join(outputDir, "uv-source-x.png"), width, height, "x");
await createMap(path.join(outputDir, "uv-source-y.png"), width, height, "y");
console.log(JSON.stringify({
  ok: true,
  outputDir,
  width,
  height,
  x: path.join(outputDir, "uv-source-x.png"),
  y: path.join(outputDir, "uv-source-y.png"),
}, null, 2));

async function createMap(outputPath, width, height, axis) {
  const data = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 3;
      const normalized = axis === "x" ? x / Math.max(1, width - 1) : y / Math.max(1, height - 1);
      const value = Math.round(normalized * 65535);
      data[offset] = (value >> 8) & 255;
      data[offset + 1] = value & 255;
      data[offset + 2] = 0;
    }
  }
  await sharp(data, {
    raw: {
      width,
      height,
      channels: 3,
    },
  })
    .png({ compressionLevel: 9 })
    .toFile(outputPath);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--width") {
      parsed.width = values[index + 1] || "";
      index += 1;
    } else if (value === "--height") {
      parsed.height = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
