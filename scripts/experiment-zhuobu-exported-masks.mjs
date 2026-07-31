import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourcePath = path.resolve(args.source || "D:/ozon/商品图/桌布/原图/TM20251025000433.png");
const referenceDir = path.resolve(args.referenceDir || "D:/ozon/商品图/桌布/套图/TM20251025000433");
const exportRoot = path.resolve(args.exportRoot || path.join(repoRoot, ".codex-work", "zhuobu-mask-export-v2"));
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-mask-candidate-check"));
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
const baseTemplate = JSON.parse(await fs.readFile(path.join(baseDir, "template.json"), "utf8"));
const exportedMasks = await readExportedMasks(exportRoot);
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuExportedMasks=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const candidates = [
  {
    name: "baseline",
    mutate: () => {},
  },
  {
    name: "exported-clipmask-alpha",
    mutate: (template) => applyExportedMasks(template, exportedMasks, "clipmask-alpha"),
  },
  {
    name: "exported-mask-red",
    mutate: (template) => applyExportedMasks(template, exportedMasks, "mask-red"),
  },
  {
    name: "exported-alpha-mask",
    copyMode: "alpha-mask",
    mutate: (template) => applyExportedMasks(template, exportedMasks, "mask-red"),
  },
  {
    name: "exported-mask-red-positioned",
    copyMode: "original",
    mutate: (template) => applyExportedMasks(template, exportedMasks, "mask-red-positioned"),
  },
  {
    name: "exported-alpha-mask-positioned",
    copyMode: "alpha-mask",
    mutate: (template) => applyExportedMasks(template, exportedMasks, "mask-red-positioned"),
  },
  {
    name: "exported-mask-red-plus-old-clip",
    mutate: (template) => applyExportedMasks(template, exportedMasks, "mask-red-plus-old-clip"),
  },
  {
    name: "remove-replace-clips",
    mutate: (template) => removeReplaceClips(template),
  },
];

const sku = path.basename(sourcePath, path.extname(sourcePath));
const sourceBuffer = await fs.readFile(sourcePath);
const summaries = [];

for (const candidate of candidates) {
  const slug = candidate.name;
  const targetDir = path.join(templateRoot, slug);
  await fs.cp(baseDir, targetDir, { recursive: true });
  await fs.mkdir(path.join(targetDir, "masks"), { recursive: true });
  await copyExportedMaskFiles(exportedMasks, targetDir, candidate.copyMode || "original");

  const template = structuredClone(baseTemplate);
  candidate.mutate(template);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(slug);

  const rendered = await renderMockupsWithTemplate({ templateDir: slug, sourceBuffer, sku });
  const metrics = [];
  for (const scene of rendered.scenes) {
    const cloudPath = path.join(outputDir, `${slug}-cloud-${String(scene.index).padStart(2, "0")}.png`);
    await fs.writeFile(cloudPath, scene.buffer);
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${String(scene.index).padStart(2, "0")}.gif`));
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
    averageFirstEight: Number(average(metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    worstFirstEight: Number(Math.min(...metrics.filter((item) => item.scene <= 8).map((item) => item.similarity)).toFixed(2)),
    metrics,
  };
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.average,
    firstEight: summary.averageFirstEight,
    worstFirstEight: summary.worstFirstEight,
  }));
}

summaries.sort((left, right) => right.averageFirstEight - left.averageFirstEight);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify(summaries, null, 2)}\n`, "utf8");
await createBestComparison(sharp, summaries[0], referenceDir, outputDir, sku);

console.table(summaries.map((item) => ({
  name: item.name,
  average: item.average,
  firstEight: item.averageFirstEight,
  worstFirstEight: item.worstFirstEight,
})));
console.log(path.join(outputDir, "summary.json"));
console.log(path.join(outputDir, `${summaries[0].name}-ps-vs-cloud.jpg`));

async function readExportedMasks(root) {
  const output = new Map();
  for (let sceneIndex = 1; sceneIndex <= 8; sceneIndex += 1) {
    const sceneDir = path.join(root, `scene-${String(sceneIndex).padStart(2, "0")}`);
    const report = JSON.parse(await fs.readFile(path.join(sceneDir, "scene-export-report.json"), "utf8"));
    for (const layer of report.scene.layers.filter((item) => item.kind === "replace")) {
      output.set(maskKey(sceneIndex, layer.name), {
        sceneIndex,
        name: layer.name,
        maskFile: layer.maskFile,
        sourceFile: path.join(sceneDir, layer.maskFile),
      });
    }
  }
  return output;
}

async function copyExportedMaskFiles(maskMap, targetDir, copyMode) {
  const copied = new Set();
  for (const item of maskMap.values()) {
    if (copied.has(item.maskFile)) {
      continue;
    }
    copied.add(item.maskFile);
    const targetPath = path.join(targetDir, item.maskFile);
    if (copyMode === "alpha-mask") {
      await sharp(item.sourceFile)
        .ensureAlpha()
        .extractChannel("alpha")
        .png()
        .toFile(targetPath);
    } else {
      await fs.copyFile(item.sourceFile, targetPath);
    }
  }
}

function applyExportedMasks(template, maskMap, mode) {
  for (const scene of template.scenes) {
    if (scene.index > 8) {
      continue;
    }
    for (const layer of scene.layers) {
      if (layer.kind !== "replace") {
        continue;
      }
      const exported = maskMap.get(maskKey(scene.index, layer.name));
      if (!exported) {
        throw new Error(`exported mask not found: scene ${scene.index} ${layer.name}`);
      }
      if (mode === "clipmask-alpha") {
        delete layer.mask;
        layer.clipMask = exported.maskFile;
        layer.clipMaskLeft = 0;
        layer.clipMaskTop = 0;
        layer.clipMaskWidth = scene.width;
        layer.clipMaskHeight = scene.height;
        layer.clipBaseName = `${layer.name} exported alpha`;
      } else if (mode === "mask-red" || mode === "mask-red-positioned") {
        layer.mask = exported.maskFile;
        if (mode === "mask-red-positioned") {
          layer.maskLeft = 0;
          layer.maskTop = 0;
          layer.maskWidth = scene.width;
          layer.maskHeight = scene.height;
        } else {
          delete layer.maskLeft;
          delete layer.maskTop;
          delete layer.maskWidth;
          delete layer.maskHeight;
        }
        delete layer.clipMask;
        delete layer.clipMaskLeft;
        delete layer.clipMaskTop;
        delete layer.clipMaskWidth;
        delete layer.clipMaskHeight;
        delete layer.clipBaseName;
      } else if (mode === "mask-red-plus-old-clip") {
        layer.mask = exported.maskFile;
      }
    }
  }
}

function removeReplaceClips(template) {
  for (const scene of template.scenes) {
    for (const layer of scene.layers) {
      if (layer.kind !== "replace") {
        continue;
      }
      delete layer.mask;
      delete layer.clipMask;
      delete layer.clipMaskLeft;
      delete layer.clipMaskTop;
      delete layer.clipMaskWidth;
      delete layer.clipMaskHeight;
      delete layer.clipBaseName;
    }
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

async function createBestComparison(sharp, best, referenceDir, outputDir, sku) {
  const panels = [];
  for (const metric of best.metrics) {
    const scene = String(metric.scene).padStart(2, "0");
    const referenceBuffer = await fs.readFile(path.join(referenceDir, `111_${sku}_${scene}.gif`));
    const cloudBuffer = await fs.readFile(path.join(outputDir, `${best.name}-cloud-${scene}.png`));
    panels.push(await createCompareRow(sharp, referenceBuffer, cloudBuffer, `scene ${metric.scene} ${metric.similarity}%`));
  }
  await sharp({
    create: {
      width: 800 * 2 + 24,
      height: panels.length * (1067 + 44) + (panels.length - 1) * 24,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite(panels.map((input, index) => ({
      input,
      left: 0,
      top: index * (1067 + 44 + 24),
    })))
    .jpeg({ quality: 90 })
    .toFile(path.join(outputDir, `${best.name}-ps-vs-cloud.jpg`));
}

async function createCompareRow(sharp, referenceBuffer, cloudBuffer, label) {
  const referencePanel = await labelPanel(sharp, referenceBuffer, "PS");
  const cloudPanel = await labelPanel(sharp, cloudBuffer, label);
  return sharp({
    create: {
      width: 800 * 2 + 24,
      height: 1067 + 44,
      channels: 3,
      background: "#f5f5f5",
    },
  })
    .composite([
      { input: referencePanel, left: 0, top: 0 },
      { input: cloudPanel, left: 824, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer, { animated: false })
    .resize({ width: 800, height: 1067, fit: "fill" })
    .jpeg({ quality: 92 })
    .toBuffer();
  const labelSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="800" height="44">
      <rect width="800" height="44" fill="#111827"/>
      <text x="18" y="29" font-family="Arial, sans-serif" font-size="22" fill="#ffffff">${escapeXml(label)}</text>
    </svg>
  `);
  return sharp({
    create: {
      width: 800,
      height: 1111,
      channels: 3,
      background: "#ffffff",
    },
  })
    .composite([
      { input: labelSvg, left: 0, top: 0 },
      { input: image, left: 0, top: 44 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

function maskKey(sceneIndex, name) {
  return `${sceneIndex}::${name}`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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
    } else if (value === "--export-root") {
      parsed.exportRoot = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
