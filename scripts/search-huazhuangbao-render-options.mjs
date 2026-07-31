import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
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

const { renderMockupsWithTemplate } = await import(`${rendererPath}?huazhuangbaoSearch=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const sceneIndexes = (args.scenes || "1,2,3,4,5,6")
  .split(",")
  .map(Number)
  .filter((value) => Number.isInteger(value) && value > 0);
const references = new Map();
for (const scene of sceneIndexes) {
  references.set(scene, await fs.readFile(path.join(referenceDir, `ps-direct-${String(scene).padStart(2, "0")}.jpg`)));
}

const candidates = [];
const modes = (args.modes || "center,edge").split(",").filter(Boolean);
const interpolations = (args.interpolations || "bicubic,bicubic-ps,bicubic-soft").split(",").filter(Boolean);
const offsetsX = (args.offsetsX || "-0.5,-0.1875,0,0.25").split(",").map(Number);
const offsetsY = (args.offsetsY || "-0.75,-0.5,-0.25,0").split(",").map(Number);
for (const perspectiveSampleMode of modes) {
  for (const perspectiveInterpolation of interpolations) {
    for (const perspectivePixelOffsetX of offsetsX) {
      for (const perspectivePixelOffsetY of offsetsY) {
        candidates.push({
          perspectiveSampleMode,
          perspectiveInterpolation,
          perspectivePixelOffsetX,
          perspectivePixelOffsetY,
        });
      }
    }
  }
}

const rows = [];
for (const candidate of candidates) {
  const rendered = await renderMockupsWithTemplate({
    templateDir: "huazhuangbao",
    sourceBuffer,
    sku: "SEARCH",
    ...candidate,
    sceneIndexes,
  });
  const maes = [];
  for (const scene of rendered.scenes) {
    maes.push(await calculateMae(sharp, references.get(scene.index), scene.buffer));
  }
  rows.push({
    ...candidate,
    average: average(maes),
    scenes: maes,
  });
}

rows.sort((left, right) => left.average - right.average);
console.table(rows.slice(0, Number(args.limit || 20)).map((row) => ({
  mode: row.perspectiveSampleMode,
  interpolation: row.perspectiveInterpolation,
  ox: row.perspectivePixelOffsetX,
  oy: row.perspectivePixelOffsetY,
  average: Number(row.average.toFixed(3)),
  scenes: row.scenes.map((value) => Number(value.toFixed(2))).join(", "),
})));

async function calculateMae(sharp, referenceBuffer, localBuffer) {
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
  for (let offset = 0; offset < reference.data.length; offset += 3) {
    sum += (
      Math.abs(reference.data[offset] - local.data[offset])
      + Math.abs(reference.data[offset + 1] - local.data[offset + 1])
      + Math.abs(reference.data[offset + 2] - local.data[offset + 2])
    ) / 3;
  }
  return sum / (reference.data.length / 3);
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
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
    } else if (value === "--limit") {
      parsed.limit = values[index + 1] || "";
      index += 1;
    } else if (value === "--scenes") {
      parsed.scenes = values[index + 1] || "";
      index += 1;
    } else if (value === "--modes") {
      parsed.modes = values[index + 1] || "";
      index += 1;
    } else if (value === "--interpolations") {
      parsed.interpolations = values[index + 1] || "";
      index += 1;
    } else if (value === "--offsets-x") {
      parsed.offsetsX = values[index + 1] || "";
      index += 1;
    } else if (value === "--offsets-y") {
      parsed.offsetsY = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}




