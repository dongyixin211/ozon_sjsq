import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repoRoot = path.resolve(import.meta.dirname, "..");
const slug = "huazhuangbao";
const sceneWidth = 1086;
const sceneHeight = 1448;
const exportDir = path.join(repoRoot, "dist", "mockup-convert", slug);
const exportReportPath = path.join(exportDir, "export-report.json");
const smartReportPath = path.join(repoRoot, "dist", "mockup-inspect-smart", slug, "smart-report.json");
const targetDir = path.join(repoRoot, "server", "src", "mockup-templates", slug);

const exportReport = JSON.parse(await fs.readFile(exportReportPath, "utf8"));
const smartReport = JSON.parse(await fs.readFile(smartReportPath, "utf8"));
if (!exportReport.ok) throw new Error(exportReport.error || "PSD export failed");
if (!smartReport.ok) throw new Error(smartReport.error || "PSD smart-object inspect failed");
const existingLayerFiles = new Set(await listLayerFiles());

await fs.rm(targetDir, { recursive: true, force: true });
await fs.mkdir(path.join(targetDir, "layers"), { recursive: true });
await fs.mkdir(path.join(targetDir, "masks"), { recursive: true });
await fs.cp(path.join(exportDir, "layers"), path.join(targetDir, "layers"), { recursive: true });
await fs.copyFile(path.join(exportDir, "preview_01.jpg"), path.join(targetDir, "preview.jpg"));

const smartByPath = new Map(smartReport.smartObjects.map((layer) => [layer.path, layer]));
const brightMasks = await createBrightMasks(existingLayerFiles);
const scenes = buildScenes(exportReport.scenes);
const template = {
  id: "huazhuangbao-v1",
  name: "\u5316\u5986\u5305\u6837\u673a",
  description: "\u9002\u5408 4:3 \u6a2a\u56fe\u5e73\u9762\u56fe\uff0c\u751f\u6210\u5316\u5986\u5305\u591a\u89d2\u5ea6\u5957\u56fe\u6548\u679c\u56fe\u3002",
  productType: "\u5316\u5986\u5305 / \u6536\u7eb3\u5305",
  sourceAspectRatio: "4:3 \u6a2a\u56fe",
  previewPath: "/mockup-template-assets/huazhuangbao/preview.jpg",
  outputWidth: sceneWidth,
  outputHeight: sceneHeight,
  outputFormat: "png",
  outputQuality: 100,
  outputChromaSubsampling: "4:4:4",
  sourceWidth: 1024,
  sourceHeight: 768,
  sourceFit: "fill",
  scenes,
};

await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  targetDir,
  scenes: template.scenes.length,
  layers: template.scenes.reduce((sum, scene) => sum + scene.layers.length, 0),
  replacements: template.scenes.reduce((sum, scene) => sum + scene.layers.filter((layer) => layer.kind === "replace").length, 0),
}, null, 2));

function buildScenes(exportScenes) {
  return [...exportScenes]
    .sort((left, right) => Number(left.index) - Number(right.index))
    .map((scene) => {
    const index = Number(scene.index);
    const sceneLayers = scene.layers
      .filter((layer) => layer.visible && Number(layer.opacity) > 0)
      .map((layer, topIndex) => ({ ...layer, topIndex }));
    const renderLayers = [];
    for (const layer of [...sceneLayers].reverse()) {
      const item = buildLayer(layer, sceneLayers, index);
      if (item) renderLayers.push(item);
    }
    return {
      id: `scene-${index}`,
      index,
      width: sceneWidth,
      height: sceneHeight,
      ...sceneOutputOffset(index),
      layers: renderLayers.map((layer, order) => ({ order, ...layer })),
    };
  });
}

function sceneOutputOffset(index) {
  if (index === 4) return { outputOffsetY: -1 };
  if (index === 5) return { outputOffsetX: -1 };
  return {};
}

function buildLayer(layer, sceneLayers, sceneIndex) {
  const opacity = clamp(Number(layer.opacity || 100) / 100, 0, 1);
  const base = {
    name: layer.name,
    left: round(Number(layer.left)),
    top: round(Number(layer.top)),
    width: Math.max(1, round(Number(layer.width))),
    height: Math.max(1, round(Number(layer.height))),
    opacity,
    kind: layer.kind === "replace" ? "replace" : "image",
  };
  const blendMode = normalizeBlendMode(layer.blendMode);
  if (blendMode) base.blendMode = blendMode;

  if (layer.kind !== "replace") {
    const file = layer.file || imageFileFor(sceneIndex, layer.topIndex);
    if (!file) return null;
    return {
      ...base,
      left: 0,
      top: 0,
      width: sceneWidth,
      height: sceneHeight,
      file,
    };
  }

  const smart = smartByPath.get(layer.path);
  const smartObjectMore = smart?.descriptor?.smartObjectMore?.value;
  const transform = Array.isArray(layer.transform) && layer.transform.length === 8
    ? layer.transform.map(round)
    : normalizeTransform(smartObjectMore?.transform, (sceneIndex - 1) * sceneHeight);
  const item = {
    ...base,
    transform,
    psTransform: transform,
    nonAffineTransform: Array.isArray(layer.nonAffineTransform) && layer.nonAffineTransform.length === 8
      ? layer.nonAffineTransform.map(round)
      : normalizeTransform(smartObjectMore?.nonAffineTransform, (sceneIndex - 1) * sceneHeight),
    sampleMode: "center",
    interpolation: "bilinear",
  };
  // The exported four-point transform matches this PSD more closely than the sampled warp mesh.
  const clipLayer = findClipLayer(layer, sceneLayers, sceneIndex);
  if (clipLayer && shouldUseClipMask(layer, clipLayer)) {
    const clipFile = imageFileFor(sceneIndex, clipLayer.topIndex);
    item.clipMask = brightMasks.get(clipFile) || clipFile;
    item.clipMaskLeft = 0;
    item.clipMaskTop = 0;
    item.clipMaskWidth = sceneWidth;
    item.clipMaskHeight = sceneHeight;
  }
  return item;
}

function shouldUseClipMask(replaceLayer, clipLayer) {
  return Boolean(replaceLayer && clipLayer);
}

function findClipLayer(layer, sceneLayers, sceneIndex) {
  for (let index = layer.topIndex + 1; index < sceneLayers.length; index += 1) {
    const candidate = sceneLayers[index];
    if (candidate.kind === "SMARTOBJECT") continue;
    if (isFullScene(candidate)) continue;
    if (imageFileFor(sceneIndex, candidate.topIndex)) return candidate;
  }
  return null;
}

function imageFileFor(sceneIndex, layerIndex) {
  const relative = `layers/scene-${pad2(sceneIndex)}-layer-${pad3(layerIndex)}.png`;
  return existingLayerFiles.has(relative) ? relative : "";
}

async function listLayerFiles() {
  const entries = await fs.readdir(path.join(exportDir, "layers"), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".png")) continue;
    const fullPath = path.join(exportDir, "layers", entry.name);
    const stat = await fs.stat(fullPath);
    if (stat.size > 0) files.push(`layers/${entry.name}`);
  }
  return files;
}

async function createBrightMasks(layerFiles) {
  const { default: sharp } = await import(pathToFileURL(path.join(repoRoot, "server", "node_modules", "sharp", "lib", "index.js")).href);
  const output = new Map();
  for (const layerFile of layerFiles) {
    const inputPath = path.join(targetDir, layerFile);
    const maskName = `bright-${path.basename(layerFile)}`;
    const maskRelative = `masks/${maskName}`;
    const image = await sharp(inputPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixels = Buffer.alloc(image.info.width * image.info.height * 4);
    for (let source = 0, target = 0; source < image.data.length; source += 4, target += 4) {
      const alpha = image.data[source + 3];
      pixels[target] = alpha;
      pixels[target + 1] = alpha;
      pixels[target + 2] = alpha;
      pixels[target + 3] = alpha;
    }
    await sharp(pixels, {
      raw: {
        width: image.info.width,
        height: image.info.height,
        channels: 4,
      },
    }).png().toFile(path.join(targetDir, maskRelative));
    output.set(layerFile, maskRelative);
  }
  return output;
}

function buildPerspectiveMesh(smartObjectMore, transform) {
  const warp = smartObjectMore.warp?.value;
  const points = warp?.customEnvelopeWarp?.value?.meshPoints;
  const width = Number(smartObjectMore.size?.value?.width || 1024);
  const height = Number(smartObjectMore.size?.value?.height || 768);
  if (!Array.isArray(points) || points.length !== 16 || width <= 0 || height <= 0) {
    return null;
  }
  const columns = 4;
  const rows = 4;
  const homography = homographyFromUnitSquare(transformToPoints(transform));
  const vertices = [];
  const warpedVertices = [];
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      vertices.push({
        x: round(column / (columns - 1)),
        y: round(row / (rows - 1)),
      });
      const point = points[row * columns + column]?.value;
      const local = {
        x: Number(point?.horizontal || 0) / width,
        y: Number(point?.vertical || 0) / height,
      };
      warpedVertices.push(roundPoint(mapUnitToTarget(homography, local.x, local.y)));
    }
  }
  const quads = [];
  for (let row = 0; row < rows - 1; row += 1) {
    for (let column = 0; column < columns - 1; column += 1) {
      const topLeft = row * columns + column;
      quads.push([topLeft, topLeft + 1, topLeft + columns + 1, topLeft + columns]);
    }
  }
  return { vertices, warpedVertices, quads };
}

function normalizeTransform(values, sceneTop) {
  if (!Array.isArray(values) || values.length !== 8) return [];
  return values.map((value, index) => round(index % 2 === 1 ? Number(value) - sceneTop : Number(value)));
}

function isFullScene(layer) {
  return Math.abs(Number(layer.width) - sceneWidth) <= 3 && Math.abs(Number(layer.height) - sceneHeight) <= 3;
}

function normalizeBlendMode(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("multiply")) return "multiply";
  if (text.includes("screen")) return "screen";
  if (text.includes("overlay")) return "overlay";
  if (text.includes("linearlight")) return "linear_light";
  return "normal";
}

function transformToPoints(values) {
  return [
    { x: values[0], y: values[1] },
    { x: values[2], y: values[3] },
    { x: values[4], y: values[5] },
    { x: values[6], y: values[7] },
  ];
}

function homographyFromUnitSquare(points) {
  const [topLeft, topRight, bottomRight, bottomLeft] = points;
  const dx1 = topRight.x - bottomRight.x;
  const dy1 = topRight.y - bottomRight.y;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < 0.000001) {
    return {
      a: topRight.x - topLeft.x,
      b: bottomLeft.x - topLeft.x,
      c: topLeft.x,
      d: topRight.y - topLeft.y,
      e: bottomLeft.y - topLeft.y,
      f: topLeft.y,
      g: 0,
      h: 0,
    };
  }
  const g = (dx3 * dy2 - dx2 * dy3) / denominator;
  const h = (dx1 * dy3 - dx3 * dy1) / denominator;
  return {
    a: topRight.x - topLeft.x + g * topRight.x,
    b: bottomLeft.x - topLeft.x + h * bottomLeft.x,
    c: topLeft.x,
    d: topRight.y - topLeft.y + g * topRight.y,
    e: bottomLeft.y - topLeft.y + h * bottomLeft.y,
    f: topLeft.y,
    g,
    h,
  };
}

function mapUnitToTarget(homography, u, v) {
  const denominator = homography.g * u + homography.h * v + 1;
  if (Math.abs(denominator) < 0.000001) return { x: 0, y: 0 };
  return {
    x: (homography.a * u + homography.b * v + homography.c) / denominator,
    y: (homography.d * u + homography.e * v + homography.f) / denominator,
  };
}

function roundPoint(point) {
  return { x: round(point.x), y: round(point.y) };
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function pad3(value) {
  return String(value).padStart(3, "0");
}




