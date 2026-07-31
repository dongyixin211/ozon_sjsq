import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, "dist", "mockup-render-check", "zhuobu-diagnose-single"));
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
const { renderMockupsWithTemplate } = await import(`${rendererPath}?diagnose=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const rendered = await renderMockupsWithTemplate({ templateDir: "zhuobu", sourceBuffer, sku });

const rows = [];
for (const scene of rendered.scenes) {
  const referencePath = path.join(referenceDir, `111_${sku}_${String(scene.index).padStart(2, "0")}.gif`);
  const referenceBuffer = await fs.readFile(referencePath);
  const cloudGifBuffer = await sharp(scene.buffer).gif({ colours: 256 }).toBuffer();
  const direct = await compare(sharp, referenceBuffer, scene.buffer);
  const asGif = await compare(sharp, referenceBuffer, cloudGifBuffer);
  const shifted = await findBestShift(sharp, referenceBuffer, scene.buffer, 3);
  rows.push({
    scene: scene.index,
    directMae: direct.mae,
    directSimilarity: direct.similarity,
    gifMae: asGif.mae,
    gifSimilarity: asGif.similarity,
    meanReference: direct.meanReference,
    meanCloud: direct.meanCloud,
    meanDelta: direct.meanDelta,
    bestShift: shifted,
  });
}

await fs.writeFile(path.join(outputDir, "diagnose.json"), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.table(rows.map((row) => ({
  scene: row.scene,
  direct: row.directSimilarity,
  gif: row.gifSimilarity,
  dR: row.meanDelta[0],
  dG: row.meanDelta[1],
  dB: row.meanDelta[2],
  shift: `${row.bestShift.dx},${row.bestShift.dy}`,
  shiftSim: row.bestShift.similarity,
})));
console.log(path.join(outputDir, "diagnose.json"));

async function compare(sharp, referenceBuffer, cloudBuffer) {
  const reference = await rawRgb(sharp, referenceBuffer);
  const cloud = await rawRgb(sharp, cloudBuffer);
  const meanReference = [0, 0, 0];
  const meanCloud = [0, 0, 0];
  let sum = 0;
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    for (let channel = 0; channel < 3; channel += 1) {
      meanReference[channel] += reference.data[offset + channel];
      meanCloud[channel] += cloud.data[offset + channel];
    }
    sum += (
      Math.abs(reference.data[offset] - cloud.data[offset])
      + Math.abs(reference.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(reference.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
  }
  const pixels = reference.data.length / 3;
  const mae = sum / pixels;
  for (let channel = 0; channel < 3; channel += 1) {
    meanReference[channel] /= pixels;
    meanCloud[channel] /= pixels;
  }
  return {
    mae: Number(mae.toFixed(3)),
    similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    meanReference: meanReference.map((value) => Number(value.toFixed(2))),
    meanCloud: meanCloud.map((value) => Number(value.toFixed(2))),
    meanDelta: meanCloud.map((value, index) => Number((value - meanReference[index]).toFixed(2))),
  };
}

async function findBestShift(sharp, referenceBuffer, cloudBuffer, radius) {
  const reference = await rawRgb(sharp, referenceBuffer);
  const cloud = await rawRgb(sharp, cloudBuffer);
  let best = { dx: 0, dy: 0, mae: Infinity, similarity: 0 };
  for (let dy = -radius; dy <= radius; dy += 1) {
    for (let dx = -radius; dx <= radius; dx += 1) {
      const mae = shiftedMae(reference, cloud, dx, dy);
      if (mae < best.mae) {
        best = {
          dx,
          dy,
          mae: Number(mae.toFixed(3)),
          similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
        };
      }
    }
  }
  return best;
}

async function rawRgb(sharp, buffer) {
  return sharp(buffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

function shiftedMae(reference, cloud, dx, dy) {
  const width = 800;
  const height = 1067;
  const left = Math.max(0, dx);
  const right = Math.min(width, width + dx);
  const top = Math.max(0, dy);
  const bottom = Math.min(height, height + dy);
  let sum = 0;
  let count = 0;
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const referenceOffset = (y * width + x) * 3;
      const cloudOffset = ((y - dy) * width + (x - dx)) * 3;
      sum += (
        Math.abs(reference.data[referenceOffset] - cloud.data[cloudOffset])
        + Math.abs(reference.data[referenceOffset + 1] - cloud.data[cloudOffset + 1])
        + Math.abs(reference.data[referenceOffset + 2] - cloud.data[cloudOffset + 2])
      ) / 3;
      count += 1;
    }
  }
  return sum / Math.max(1, count);
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
