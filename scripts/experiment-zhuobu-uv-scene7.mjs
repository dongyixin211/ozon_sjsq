import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const uvRoot = path.resolve(args.uvRoot || path.join(repoRoot, ".codex-work", "mockup-uv", "zhuobu-scene7"));
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-uv-scene7-check"));
const templateRoot = path.join(outputDir, "templates");
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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuUvScene7=${Date.now()}`);
const { default: sharp } = await import(sharpPath);
const sourceBuffer = await fs.readFile(sourcePath);
const sku = path.basename(sourcePath, path.extname(sourcePath));

const candidates = [
  {
    name: "baseline",
    mutate: () => {},
  },
  {
    name: "scene7-uv",
    mutate: (template) => applyScene7Uv(template, false, "rg16"),
  },
  {
    name: "scene7-uv-no-mask",
    mutate: (template) => applyScene7Uv(template, true, "rg16"),
  },
  {
    name: "scene7-uv-r8",
    convertUv: "r8",
    mutate: (template) => applyScene7Uv(template, false, "r8"),
  },
];

const summaries = [];
for (const candidate of candidates) {
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  await fs.mkdir(path.join(targetDir, "uv"), { recursive: true });
  await copyScene7UvFiles(targetDir);
  if (candidate.convertUv === "r8") {
    await convertScene7UvFilesToR8(targetDir);
  }

  const templatePath = path.join(targetDir, "template.json");
  const template = JSON.parse(await fs.readFile(templatePath, "utf8"));
  await candidate.mutate(template);
  await fs.writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rendered = await renderMockupsWithTemplate({ templateDir: candidate.name, sourceBuffer, sku });
  const metrics = [];
  for (const scene of rendered.scenes) {
    const sceneId = String(scene.index).padStart(2, "0");
    await fs.writeFile(path.join(outputDir, `${candidate.name}-cloud-${sceneId}.png`), scene.buffer);
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${sceneId}.gif`));
    const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
    metrics.push({
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
    });
  }
  const summary = {
    name: candidate.name,
    average: Number(average(metrics.map((item) => item.similarity)).toFixed(2)),
    firstEight: Number(average(metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    scene7: metrics.find((item) => item.scene === 7)?.similarity,
    metrics,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.average,
    firstEight: summary.firstEight,
    scene7: summary.scene7,
  }));
}

await createScene7Comparison(sharp, summaries, referenceDir, outputDir, sku);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
console.table(summaries.map((item) => ({
  name: item.name,
  average: item.average,
  firstEight: item.firstEight,
  scene7: item.scene7,
})));
console.log(path.join(outputDir, "summary.json"));
console.log(path.join(outputDir, "scene7-compare.jpg"));

async function copyScene7UvFiles(targetDir) {
  const uvFiles = await fs.readdir(path.join(uvRoot, "uv"));
  for (const file of uvFiles) {
    if (/scene-07-layer-001.*-[xy]\.png$/i.test(file) || /scene-07-layer-003.*-[xy]\.png$/i.test(file)) {
      await fs.copyFile(path.join(uvRoot, "uv", file), path.join(targetDir, "uv", file));
    }
  }
}

async function findUvFile(layerIndex, axis) {
  const files = await fs.readdir(path.join(uvRoot, "uv"));
  const prefix = `scene-07-layer-${String(layerIndex).padStart(3, "0")}-`;
  const found = files.find((file) => file.startsWith(prefix) && file.endsWith(`-${axis}.png`));
  if (!found) {
    throw new Error(`UV file not found: layer ${layerIndex} ${axis}`);
  }
  return `uv/${found}`;
}

async function applyScene7Uv(template, removeMask, encoding) {
  const scene = template.scenes.find((item) => item.index === 7);
  if (!scene) {
    throw new Error("scene 7 not found");
  }
  const replaceLayers = scene.layers
    .filter((layer) => layer.kind === "replace")
    .sort((left, right) => left.order - right.order);
  const topLayer = replaceLayers.find((layer) => layer.name.includes("拷贝 18")) || replaceLayers[0];
  const lowerLayer = replaceLayers.find((layer) => layer.name.includes("拷贝 7")) || replaceLayers[1];
  if (!topLayer || !lowerLayer) {
    throw new Error("scene 7 replace layers not found");
  }
  topLayer.uvMapX = await findUvFile(3, "x");
  topLayer.uvMapY = await findUvFile(3, "y");
  topLayer.uvMapEncoding = encoding;
  lowerLayer.uvMapX = await findUvFile(1, "x");
  lowerLayer.uvMapY = await findUvFile(1, "y");
  lowerLayer.uvMapEncoding = encoding;
  if (removeMask) {
    delete topLayer.mask;
    delete lowerLayer.mask;
  }
}

async function convertScene7UvFilesToR8(targetDir) {
  const files = await fs.readdir(path.join(targetDir, "uv"));
  for (const file of files) {
    if (!file.endsWith(".png")) {
      continue;
    }
    const fullPath = path.join(targetDir, "uv", file);
    const { data, info } = await sharp(fullPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const output = Buffer.alloc(info.width * info.height * 4);
    for (let source = 0, target = 0; source < data.length; source += 4, target += 4) {
      output[target] = data[source];
      output[target + 1] = data[source];
      output[target + 2] = data[source];
      output[target + 3] = data[source + 3];
    }
    await sharp(output, {
      raw: {
        width: info.width,
        height: info.height,
        channels: 4,
      },
    }).png().toFile(`${fullPath}.tmp.png`);
    await fs.rename(`${fullPath}.tmp.png`, fullPath);
  }
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
  return sum / (reference.data.length / 3);
}

async function rawRgb(sharp, buffer) {
  return sharp(buffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
}

async function createScene7Comparison(sharp, summaries, referenceDir, outputDir, sku) {
  const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_07.gif`));
  const panels = [await labelPanel(sharp, referenceBuffer, "PS scene 7")];
  for (const summary of summaries) {
    const buffer = await fs.readFile(path.join(outputDir, `${summary.name}-cloud-07.png`));
    panels.push(await labelPanel(sharp, buffer, `${summary.name} ${summary.scene7}%`));
  }
  await sharp({
    create: {
      width: panels.length * 360 + (panels.length - 1) * 12,
      height: 524,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({ input, left: index * 372, top: 0 })))
    .jpeg({ quality: 90 })
    .toFile(path.join(outputDir, "scene7-compare.jpg"));
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false }).resize({ width: 360, height: 480, fit: "fill" }).jpeg({ quality: 90 }).toBuffer();
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="360" height="44"><rect width="360" height="44" fill="#111827"/><text x="12" y="28" font-family="Arial" font-size="18" fill="#fff">${escapeXml(label)}</text></svg>`);
  return sharp({ create: { width: 360, height: 524, channels: 3, background: "#fff" } })
    .composite([{ input: svg, left: 0, top: 0 }, { input: image, left: 0, top: 44 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
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
    } else if (value === "--uv-root") {
      parsed.uvRoot = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
