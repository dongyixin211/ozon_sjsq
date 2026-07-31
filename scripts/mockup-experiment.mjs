import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);
const repoRoot = path.resolve(import.meta.dirname, "..");
const templatePath = path.join(repoRoot, "server", "src", "mockup-templates", "fangjin", "template.json");
const outputDir = path.join(repoRoot, "dist", "ps-compare");
const lockPath = path.join(outputDir, ".mockup-experiment.lock");
const sourcePath = "D:/ozon/商品图/原图/TJ20251116000279.png";
const psDir = "D:/ozon/商品图/套图/TJ20251116000279/images";
const rendererPath = pathToFileURL(path.join(repoRoot, "server", "dist", "src", "mockup-renderer.js")).href;
const sharpPath = pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href;

const options = parseArgs(process.argv.slice(2));
const experiment = options.experiment || "baseline";
const linearLightStrength = options.linearLightStrength || "";
const perspectiveSampleMode = options.perspectiveSampleMode || "";
const perspectiveInterpolation = options.perspectiveInterpolation || "";
const perspectivePixelOffsetX = options.perspectivePixelOffsetX || "";
const perspectivePixelOffsetY = options.perspectivePixelOffsetY || "";
const sourceSize = options.sourceSize || "";
const sourceResizeKernel = options.sourceResizeKernel || "";
const measureAsGif = options.measureAsGif;
const originalTemplate = await fs.readFile(templatePath, "utf8");
let lockAcquired = false;

try {
  await acquireLock();
  lockAcquired = true;
  const template = JSON.parse(originalTemplate);
  if (experiment === "no-linear-light") {
    for (const scene of template.scenes) {
      for (const layer of scene.layers) {
        if (layer.blendMode === "linear_light") {
          layer.blendMode = "normal";
        }
      }
    }
  }
  if (experiment.startsWith("no-linear-light-scenes-")) {
    const sceneIndexes = new Set(experiment.replace("no-linear-light-scenes-", "").split("-").map(Number));
    for (const scene of template.scenes) {
      if (!sceneIndexes.has(scene.index)) {
        continue;
      }
      for (const layer of scene.layers) {
        if (layer.blendMode === "linear_light") {
          layer.blendMode = "normal";
        }
      }
    }
  }
  if (experiment.startsWith("disable-linear-light-scenes-")) {
    const sceneIndexes = new Set(experiment.replace("disable-linear-light-scenes-", "").split("-").map(Number));
    for (const scene of template.scenes) {
      if (!sceneIndexes.has(scene.index)) {
        continue;
      }
      scene.layers = scene.layers.filter((layer) => layer.blendMode !== "linear_light");
    }
  }
  if (experiment.startsWith("center-scenes-")) {
    const sceneIndexes = new Set(experiment.replace("center-scenes-", "").split("-").map(Number));
    for (const scene of template.scenes) {
      if (!sceneIndexes.has(scene.index)) {
        continue;
      }
      for (const layer of scene.layers) {
        if (layer.kind === "replace") {
          layer.sampleMode = "center";
        }
      }
    }
  }
  if (experiment === "center-large") {
    for (const scene of template.scenes) {
      for (const layer of scene.layers) {
        if (layer.kind === "replace" && layer.width * layer.height >= 500_000) {
          layer.sampleMode = "center";
        }
      }
    }
  }
  if (experiment === "center-large-plus-5-6") {
    for (const scene of template.scenes) {
      for (const layer of scene.layers) {
        if (layer.kind === "replace" && (scene.index === 5 || scene.index === 6 || layer.width * layer.height >= 500_000)) {
          layer.sampleMode = "center";
        }
      }
    }
  }
  if (experiment.startsWith("bicubic-scenes-")) {
    const sceneIndexes = new Set(experiment.replace("bicubic-scenes-", "").split("-").map(Number));
    for (const scene of template.scenes) {
      if (!sceneIndexes.has(scene.index)) {
        continue;
      }
      for (const layer of scene.layers) {
        if (layer.kind === "replace") {
          layer.interpolation = "bicubic";
        }
      }
    }
  }
  if (experiment === "bicubic-center-current") {
    for (const scene of template.scenes) {
      for (const layer of scene.layers) {
        if (layer.kind === "replace" && layer.sampleMode === "center") {
          layer.interpolation = "bicubic";
        }
      }
    }
  }
  if (experiment.startsWith("scene6-ll-")) {
    const [, , targetOrderText, strengthText] = experiment.split("-");
    const targetOrder = targetOrderText === "all" ? null : Number(targetOrderText);
    const strength = Number(strengthText);
    for (const scene of template.scenes) {
      if (scene.index !== 6) {
        continue;
      }
      for (const layer of scene.layers) {
        if (layer.blendMode === "linear_light" && (targetOrder === null || layer.order === targetOrder)) {
          layer.blendStrength = strength;
        }
      }
    }
  }
  if (experiment.startsWith("scene-ll-strength-")) {
    const [, , , sceneText, strengthText] = experiment.split("-");
    const sceneIndex = Number(sceneText);
    const strength = Number(strengthText);
    for (const scene of template.scenes) {
      if (scene.index === sceneIndex) {
        scene.linearLightStrength = strength;
      }
    }
  }
  if (experiment.startsWith("interpolation-scenes-")) {
    const [, , sceneText, interpolation] = experiment.split("-");
    const sceneIndexes = new Set(sceneText.split("_").map(Number));
    for (const scene of template.scenes) {
      if (!sceneIndexes.has(scene.index)) {
        continue;
      }
      for (const layer of scene.layers) {
        if (layer.kind === "replace") {
          layer.interpolation = interpolation;
        }
      }
    }
  }
  if (experiment.startsWith("interpolation-layer-")) {
    const [, , sceneText, orderText, interpolation] = experiment.split("-");
    const sceneIndex = Number(sceneText);
    const layerOrder = Number(orderText);
    for (const scene of template.scenes) {
      if (scene.index !== sceneIndex) {
        continue;
      }
      for (const layer of scene.layers) {
        if (layer.kind === "replace" && layer.order === layerOrder) {
          layer.interpolation = interpolation;
        }
      }
    }
  }
  if (experiment.startsWith("output-quality-")) {
    const quality = Number(experiment.replace("output-quality-", ""));
    if (Number.isFinite(quality)) {
      template.outputQuality = quality;
    }
  }
  if (experiment.startsWith("output-format-")) {
    const format = experiment.replace("output-format-", "");
    if (["jpeg", "png", "webp"].includes(format)) {
      template.outputFormat = format;
    }
  }
  await fs.writeFile(templatePath, `${JSON.stringify(template, null, 2)}\n`, "utf8");
  await execAsync("npm run build", {
    cwd: path.join(repoRoot, "server"),
    timeout: 120_000,
    env: experimentEnv(),
  });
  const result = await renderAndMeasure(experiment);
  console.table(result.rows);
  console.log(result.comparePath);
} finally {
  if (lockAcquired) {
    await fs.writeFile(templatePath, originalTemplate, "utf8");
    await releaseLock();
  }
}

async function acquireLock() {
  await fs.mkdir(outputDir, { recursive: true });
  try {
    const handle = await fs.open(lockPath, "wx");
    await handle.writeFile(JSON.stringify({
      pid: process.pid,
      experiment,
      createdAt: new Date().toISOString(),
    }));
    await handle.close();
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`已有套图实验正在运行，请等它结束后重试：${lockPath}`);
    }
    throw error;
  }
}

async function releaseLock() {
  try {
    await fs.rm(lockPath, { force: true });
  } catch {
    // 锁文件清理失败不影响模板恢复。
  }
}

async function renderAndMeasure(label) {
  await fs.mkdir(outputDir, { recursive: true });
  if (linearLightStrength) {
    process.env.MOCKUP_LINEAR_LIGHT_STRENGTH = linearLightStrength;
  } else {
    delete process.env.MOCKUP_LINEAR_LIGHT_STRENGTH;
  }
  if (perspectiveSampleMode) {
    process.env.MOCKUP_PERSPECTIVE_SAMPLE_MODE = perspectiveSampleMode;
  } else {
    delete process.env.MOCKUP_PERSPECTIVE_SAMPLE_MODE;
  }
  if (perspectiveInterpolation) {
    process.env.MOCKUP_PERSPECTIVE_INTERPOLATION = perspectiveInterpolation;
  } else {
    delete process.env.MOCKUP_PERSPECTIVE_INTERPOLATION;
  }
  if (perspectivePixelOffsetX) {
    process.env.MOCKUP_PERSPECTIVE_PIXEL_OFFSET_X = perspectivePixelOffsetX;
  } else {
    delete process.env.MOCKUP_PERSPECTIVE_PIXEL_OFFSET_X;
  }
  if (perspectivePixelOffsetY) {
    process.env.MOCKUP_PERSPECTIVE_PIXEL_OFFSET_Y = perspectivePixelOffsetY;
  } else {
    delete process.env.MOCKUP_PERSPECTIVE_PIXEL_OFFSET_Y;
  }
  if (sourceSize) {
    process.env.MOCKUP_SOURCE_SIZE = sourceSize;
  } else {
    delete process.env.MOCKUP_SOURCE_SIZE;
  }
  if (sourceResizeKernel) {
    process.env.MOCKUP_SOURCE_RESIZE_KERNEL = sourceResizeKernel;
  } else {
    delete process.env.MOCKUP_SOURCE_RESIZE_KERNEL;
  }
  const { renderFangjinMockups } = await import(`${rendererPath}?experiment=${Date.now()}`);
  const { default: sharp } = await import(sharpPath);
  const sourceBuffer = await prepareExperimentSource(sharp, await fs.readFile(sourcePath), label);
  const rendered = await renderFangjinMockups({
    sourceBuffer,
    sku: "TJ20251116000279",
  });

  const rows = [];
  const panels = [];
  for (const scene of rendered.scenes) {
    const cloudPath = path.join(outputDir, `${label}-cloud-${String(scene.index).padStart(2, "0")}${path.extname(scene.filename) || ".jpg"}`);
    await fs.writeFile(cloudPath, scene.buffer);
    const psPath = path.join(psDir, `111_TJ20251116000279_${String(scene.index).padStart(2, "0")}.gif`);
    const psDirectBuffer = await sharp(psPath, { animated: false }).toBuffer();
    const psBuffer = await sharp(psDirectBuffer).jpeg({ quality: 92 }).toBuffer();
    const cloudForMeasure = measureAsGif
      ? await sharp(scene.buffer).gif({ colours: 256 }).jpeg({ quality: 92 }).toBuffer()
      : scene.buffer;
    const mae = await calculateMae(sharp, psBuffer, cloudForMeasure);
    const directMae = await calculateMae(sharp, psDirectBuffer, scene.buffer);
    rows.push({
      scene: scene.index,
      mae: Number(mae.toFixed(3)),
      directMae: Number(directMae.toFixed(3)),
    });
    panels.push(await createCompareRow(sharp, psBuffer, scene.buffer, `${label} ${scene.index}`));
  }

  const comparePath = path.join(outputDir, `${label}-compare.jpg`);
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
    .toFile(comparePath);

  return { rows, comparePath };
}

async function prepareExperimentSource(sharp, sourceBuffer, label) {
  if (label.startsWith("source-jpeg-q-")) {
    const quality = Number(label.replace("source-jpeg-q-", ""));
    return sharp(sourceBuffer)
      .resize(1024, 1024, { fit: "cover", position: "centre" })
      .jpeg({ quality, mozjpeg: true })
      .png()
      .toBuffer();
  }
  return sourceBuffer;
}

function experimentEnv() {
  return {
    ...process.env,
    ...(linearLightStrength ? { MOCKUP_LINEAR_LIGHT_STRENGTH: linearLightStrength } : {}),
    ...(perspectiveSampleMode ? { MOCKUP_PERSPECTIVE_SAMPLE_MODE: perspectiveSampleMode } : {}),
    ...(perspectiveInterpolation ? { MOCKUP_PERSPECTIVE_INTERPOLATION: perspectiveInterpolation } : {}),
    ...(perspectivePixelOffsetX ? { MOCKUP_PERSPECTIVE_PIXEL_OFFSET_X: perspectivePixelOffsetX } : {}),
    ...(perspectivePixelOffsetY ? { MOCKUP_PERSPECTIVE_PIXEL_OFFSET_Y: perspectivePixelOffsetY } : {}),
    ...(sourceSize ? { MOCKUP_SOURCE_SIZE: sourceSize } : {}),
    ...(sourceResizeKernel ? { MOCKUP_SOURCE_RESIZE_KERNEL: sourceResizeKernel } : {}),
  };
}

async function calculateMae(sharp, psBuffer, cloudBuffer) {
  const ps = await sharp(psBuffer)
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
  for (let offset = 0; offset < ps.data.length; offset += 3) {
    sum += (
      Math.abs(ps.data[offset] - cloud.data[offset])
      + Math.abs(ps.data[offset + 1] - cloud.data[offset + 1])
      + Math.abs(ps.data[offset + 2] - cloud.data[offset + 2])
    ) / 3;
  }
  return sum / (ps.data.length / 3);
}

async function createCompareRow(sharp, psBuffer, cloudBuffer, label) {
  const psPanel = await labelPanel(sharp, psBuffer, "PS");
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
      { input: psPanel, left: 0, top: 0 },
      { input: cloudPanel, left: 824, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function labelPanel(sharp, buffer, label) {
  const image = await sharp(buffer)
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

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function parseArgs(args) {
  const parsed = {
    experiment: "",
    linearLightStrength: "",
    perspectiveSampleMode: "",
    perspectiveInterpolation: "",
    perspectivePixelOffsetX: "",
    perspectivePixelOffsetY: "",
    sourceSize: "",
    sourceResizeKernel: "",
    measureAsGif: false,
  };
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--linear-light-strength") {
      parsed.linearLightStrength = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--sample-mode") {
      parsed.perspectiveSampleMode = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--interpolation") {
      parsed.perspectiveInterpolation = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--pixel-offset") {
      parsed.perspectivePixelOffsetX = args[index + 1] || "";
      parsed.perspectivePixelOffsetY = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--pixel-offset-x") {
      parsed.perspectivePixelOffsetX = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--pixel-offset-y") {
      parsed.perspectivePixelOffsetY = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--measure-as-gif") {
      parsed.measureAsGif = true;
      continue;
    }
    if (arg === "--source-size") {
      parsed.sourceSize = args[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--source-kernel") {
      parsed.sourceResizeKernel = args[index + 1] || "";
      index += 1;
      continue;
    }
    positional.push(arg);
  }
  parsed.experiment = positional[0] || "baseline";
  parsed.linearLightStrength ||= normalizeOptionalArg(positional[1]);
  parsed.perspectiveSampleMode ||= normalizeOptionalArg(positional[2]);
  parsed.perspectiveInterpolation ||= normalizeOptionalArg(positional[3]);
  return parsed;
}

function normalizeOptionalArg(value) {
  if (!value || value === "-" || value === "none" || value === "default") {
    return "";
  }
  return value;
}
