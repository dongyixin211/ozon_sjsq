import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const sourceDir = path.resolve(args.sourceDir || "D:/ozon/商品图/桌布/原图");
const referenceRoot = path.resolve(args.referenceRoot || "D:/ozon/商品图/桌布/套图");
const outputDir = path.resolve(args.outputDir || path.join(repoRoot, ".codex-work", "zhuobu-mask-batch"));
const templateRoot = path.join(outputDir, "templates");
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;
const candidateFilter = args.candidates
  ? new Set(args.candidates.split(",").map((value) => value.trim()).filter(Boolean))
  : null;
const sceneIndexes = args.scenes
  ? args.scenes.split(",").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0)
  : undefined;

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
const { renderMockupsWithTemplate, invalidateMockupTemplateCache } = await import(`${rendererPath}?zhuobuMaskBatch=${Date.now()}`);
const { default: sharp } = await import(sharpPath);

const sourceFiles = (await fs.readdir(sourceDir))
  .filter((file) => /\.(png|jpe?g|webp)$/i.test(file))
  .sort();
const samples = [];
for (const file of sourceFiles) {
  const sku = path.basename(file, path.extname(file));
  const refs = await completeReferenceFiles(referenceRoot, sku);
  if (!refs) {
    continue;
  }
  samples.push({
    sku,
    sourcePath: path.join(sourceDir, file),
    refs,
  });
}

if (!samples.length) {
  throw new Error("没有找到可用的桌布 PS 参考图");
}

const candidates = [
  {
    name: "baseline-red",
    mutate: async () => {},
  },
  {
    name: "all-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "alpha" }),
  },
  {
    name: "all-red-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "red-alpha" }),
  },
  {
    name: "all-alpha-binary",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "alpha-binary" }),
  },
  {
    name: "scene7-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "alpha", scenes: new Set([7]) }),
  },
  {
    name: "scene7-alpha-binary",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "alpha-binary", scenes: new Set([7]) }),
  },
  {
    name: "scene2-red-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "red-alpha", scenes: new Set([2]) }),
  },
  {
    name: "scene5-red-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "red-alpha", scenes: new Set([5]) }),
  },
  {
    name: "scene7-red-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "red-alpha", scenes: new Set([7]) }),
  },
  {
    name: "scene1-2-5-7-red-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "red-alpha", scenes: new Set([1, 2, 5, 7]) }),
  },
  {
    name: "scene1-2-4-5-7-red-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "red-alpha", scenes: new Set([1, 2, 4, 5, 7]) }),
  },
  {
    name: "scene1-2-5-7-8-red-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "red-alpha", scenes: new Set([1, 2, 5, 7, 8]) }),
  },
  {
    name: "scene1-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "alpha", scenes: new Set([1]) }),
  },
  {
    name: "scene1-alpha-binary",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "alpha-binary", scenes: new Set([1]) }),
  },
  {
    name: "scene1-red-alpha",
    mutate: async (template, targetDir) => convertMasks(targetDir, template, { mode: "red-alpha", scenes: new Set([1]) }),
  },
  {
    name: "scene7-no-mask",
    mutate: async (template) => removeMasks(template, new Set([7])),
  },
  {
    name: "scene1-no-mask",
    mutate: async (template) => removeMasks(template, new Set([1])),
  },
];

const summaries = [];
for (const candidate of candidates) {
  if (candidateFilter && !candidateFilter.has(candidate.name)) {
    continue;
  }
  const targetDir = path.join(templateRoot, candidate.name);
  await fs.cp(baseDir, targetDir, { recursive: true });
  const template = structuredClone(baseTemplate);
  await candidate.mutate(template, targetDir);
  await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
  invalidateMockupTemplateCache(candidate.name);

  const rows = [];
  for (const sample of samples) {
    const sourceBuffer = await fs.readFile(sample.sourcePath);
    const rendered = await renderMockupsWithTemplate({
      templateDir: candidate.name,
      sourceBuffer,
      sku: sample.sku,
      sceneIndexes,
    });
    for (const scene of rendered.scenes) {
      const sceneId = String(scene.index).padStart(2, "0");
      if (args.keepImages === "true") {
        await fs.writeFile(path.join(outputDir, `${candidate.name}-${sample.sku}-${sceneId}.png`), scene.buffer);
      }
      const referenceBuffer = await fs.readFile(sample.refs[scene.index]);
      const mae = await calculateMae(sharp, referenceBuffer, scene.buffer);
      rows.push({
        sku: sample.sku,
        scene: scene.index,
        mae: Number(mae.toFixed(3)),
        similarity: Number((100 - (mae / 255) * 100).toFixed(2)),
      });
    }
  }

  const summary = summarize(candidate.name, rows);
  summaries.push(summary);
  console.log(JSON.stringify({
    name: summary.name,
    average: summary.averageSimilarity,
    firstEight: summary.firstEightSimilarity,
    worst: summary.worstSimilarity,
    scene1: summary.sceneSummary.find((item) => item.scene === 1)?.similarity,
    scene7: summary.sceneSummary.find((item) => item.scene === 7)?.similarity,
  }));
}

summaries.sort((left, right) => right.firstEightSimilarity - left.firstEightSimilarity);
await fs.writeFile(path.join(outputDir, "summary.json"), `${JSON.stringify({ samples: samples.map((sample) => sample.sku), summaries }, null, 2)}\n`, "utf8");

console.table(summaries.map((item) => ({
  name: item.name,
  average: item.averageSimilarity,
  firstEight: item.firstEightSimilarity,
  worst: item.worstSimilarity,
  scene1: item.sceneSummary.find((scene) => scene.scene === 1)?.similarity,
  scene7: item.sceneSummary.find((scene) => scene.scene === 7)?.similarity,
})));
console.log(path.join(outputDir, "summary.json"));

async function completeReferenceFiles(root, sku) {
  const candidateDirs = [
    path.join(root, sku),
    path.join(root, sku, "images"),
  ];
  for (const refDir of candidateDirs) {
    const refs = {};
    let complete = true;
    for (let scene = 1; scene <= 9; scene += 1) {
      const file = path.join(refDir, `111_${sku}_${String(scene).padStart(2, "0")}.gif`);
      try {
        await fs.access(file);
        refs[scene] = file;
      } catch {
        complete = false;
        break;
      }
    }
    if (complete) {
      return refs;
    }
  }
  return null;
}

async function convertMasks(targetDir, template, options) {
  const maskFiles = new Set();
  for (const scene of template.scenes) {
    if (options.scenes && !options.scenes.has(scene.index)) {
      continue;
    }
    for (const layer of scene.layers) {
      if (layer.kind === "replace" && layer.mask) {
        maskFiles.add(layer.mask);
      }
    }
  }
  for (const relativePath of maskFiles) {
    await convertMask(path.join(targetDir, relativePath), options.mode);
  }
}

async function convertMask(inputPath, mode) {
  const { data, info } = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const output = Buffer.alloc(info.width * info.height);
  for (let source = 0, target = 0; source < data.length; source += 4, target += 1) {
    const red = data[source];
    const alpha = data[source + 3];
    if (mode === "alpha") {
      output[target] = alpha;
    } else if (mode === "alpha-binary") {
      output[target] = alpha > 8 ? 255 : 0;
    } else if (mode === "red-alpha") {
      output[target] = Math.round((red * alpha) / 255);
    } else {
      output[target] = red;
    }
  }
  await sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 1,
    },
  }).png().toFile(`${inputPath}.tmp.png`);
  await fs.rename(`${inputPath}.tmp.png`, inputPath);
}

function removeMasks(template, scenes) {
  for (const scene of template.scenes) {
    if (!scenes.has(scene.index)) {
      continue;
    }
    for (const layer of scene.layers) {
      if (layer.kind === "replace") {
        delete layer.mask;
      }
    }
  }
}

function summarize(name, rows) {
  const sceneSummary = [];
  for (let scene = 1; scene <= 9; scene += 1) {
    const sceneRows = rows.filter((row) => row.scene === scene);
    if (!sceneRows.length) {
      continue;
    }
    sceneSummary.push({
      scene,
      similarity: Number(average(sceneRows.map((row) => row.similarity)).toFixed(2)),
      worstSimilarity: Number(Math.min(...sceneRows.map((row) => row.similarity)).toFixed(2)),
    });
  }
  const firstEight = rows.filter((row) => row.scene <= 8);
  return {
    name,
    averageSimilarity: Number(average(rows.map((row) => row.similarity)).toFixed(2)),
    firstEightSimilarity: Number(average(firstEight.map((row) => row.similarity)).toFixed(2)),
    worstSimilarity: Number(Math.min(...rows.map((row) => row.similarity)).toFixed(2)),
    sceneSummary,
    rows,
  };
}

async function calculateMae(sharp, referenceBuffer, cloudBuffer) {
  const reference = await sharp(referenceBuffer, { animated: false })
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const cloud = await sharp(cloudBuffer)
    .resize(800, 1067, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
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

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--source-dir") {
      parsed.sourceDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--reference-root") {
      parsed.referenceRoot = values[index + 1] || "";
      index += 1;
    } else if (value === "--output-dir") {
      parsed.outputDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--keep-images") {
      parsed.keepImages = values[index + 1] || "";
      index += 1;
    } else if (value === "--candidates") {
      parsed.candidates = values[index + 1] || "";
      index += 1;
    } else if (value === "--scenes") {
      parsed.scenes = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}
