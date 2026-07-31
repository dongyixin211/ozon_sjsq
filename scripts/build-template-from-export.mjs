import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const args = parseArgs(process.argv.slice(2));
const slug = args.slug || "ganfamao";
const exportDir = path.resolve(args.exportDir || path.join(repoRoot, "dist", "mockup-convert", slug));
const targetDir = path.resolve(args.targetDir || path.join(repoRoot, "server", "src", "mockup-templates", slug));

const report = JSON.parse(await fs.readFile(path.join(exportDir, "export-report.json"), "utf8"));
if (!report.ok) {
  throw new Error(report.error || "PSD export failed");
}

await fs.rm(targetDir, { recursive: true, force: true });
await fs.mkdir(path.join(targetDir, "layers"), { recursive: true });
await fs.cp(path.join(exportDir, "layers"), path.join(targetDir, "layers"), { recursive: true });
if (await pathExists(path.join(exportDir, "masks"))) {
  await fs.cp(path.join(exportDir, "masks"), path.join(targetDir, "masks"), { recursive: true });
}
await fs.copyFile(path.join(exportDir, "preview_01.jpg"), path.join(targetDir, "preview.jpg"));

const metadata = metadataForSlug(slug);
const template = {
  id: `${slug}-v1`,
  name: metadata.name,
  description: metadata.description,
  productType: metadata.productType,
  sourceAspectRatio: metadata.sourceAspectRatio,
  previewPath: `/mockup-template-assets/${slug}/preview.jpg`,
  outputWidth: Number(report.sceneWidth || 800),
  outputHeight: Number(report.sceneHeight || 1067),
  outputFormat: "png",
  outputQuality: 100,
  outputChromaSubsampling: "4:4:4",
  scenes: report.scenes.map((scene) => buildScene(scene)),
};
if (metadata.sourceWidth && metadata.sourceHeight) {
  template.sourceWidth = metadata.sourceWidth;
  template.sourceHeight = metadata.sourceHeight;
  template.sourceFit = metadata.sourceFit || "cover";
} else {
  template.sourceSize = 1024;
}

await fs.writeFile(path.join(targetDir, "template.json"), `${JSON.stringify(template, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  ok: true,
  slug,
  targetDir,
  scenes: template.scenes.length,
  layers: template.scenes.reduce((sum, scene) => sum + scene.layers.length, 0),
  clipMasks: template.scenes.reduce((sum, scene) => sum + scene.layers.filter((layer) => layer.clipMask).length, 0),
}, null, 2));

function buildScene(scene) {
  const sortedLayers = [...scene.layers].reverse();
  const allLayersByTopIndex = new Map(scene.layers.map((layer) => [layer.topToBottomIndex, layer]));
  const clipLayerFiles = new Set(scene.layers.flatMap((layer) => {
    if (!shouldRenderReplaceLayer(layer) || layer.kind !== "replace" || layer.maskFile) {
      return [];
    }
    const clipLayer = findClipLayer(layer, allLayersByTopIndex, scene);
    return clipLayer?.file ? [clipLayer.file] : [];
  }));
  return {
    id: `scene-${scene.index}`,
    index: scene.index,
    width: Number(scene.width),
    height: Number(scene.height),
    layers: sortedLayers
      .filter((layer) => shouldRenderLayer(layer, clipLayerFiles))
      .map((layer, order) => buildLayer(layer, order, scene, allLayersByTopIndex)),
  };
}

function shouldRenderLayer(layer, clipLayerFiles) {
  if (layer.kind === "replace" && !shouldRenderReplaceLayer(layer)) {
    return false;
  }
  if (slug === "ganfamao" && layer.kind === "image" && isGanfamaoAuxiliaryMaskLayer(layer)) {
    return false;
  }
  return !clipLayerFiles.has(layer.file);
}

function shouldRenderReplaceLayer(layer) {
  if (slug !== "ganfamao") {
    return true;
  }
  return String(layer.name || "").includes("\u94fe\u63a5\u56fe");
}

function isGanfamaoAuxiliaryMaskLayer(layer) {
  const name = String(layer.name || "");
  if (name === "y" || name === "z" || name === ".q") {
    return true;
  }
  return name.includes("\u62a0\u56fe") && normalizeBlendMode(layer.blendMode) !== "linear_light";
}

function buildLayer(layer, order, scene, allLayersByTopIndex) {
  const item = {
    order,
    name: layer.name,
    left: round(layer.left),
    top: round(layer.top),
    width: Math.max(1, round(layer.width)),
    height: Math.max(1, round(layer.height)),
    opacity: Math.max(0, Math.min(1, Number(layer.opacity || 100) / 100)),
    kind: layer.kind,
  };
  const blendMode = normalizeBlendMode(layer.blendMode);
  if (blendMode) {
    item.blendMode = blendMode;
  }
  if (layer.kind === "image") {
    item.file = layer.file;
    item.left = 0;
    item.top = 0;
    item.width = Number(scene.width);
    item.height = Number(scene.height);
  } else if (layer.kind === "replace") {
    if (Array.isArray(layer.transform) && layer.transform.length === 8) {
      item.transform = layer.transform.map(round);
      item.psTransform = item.transform;
      item.sampleMode = "center";
      item.interpolation = "bicubic";
    }
    if (Array.isArray(layer.nonAffineTransform) && layer.nonAffineTransform.length === 8) {
      item.nonAffineTransform = layer.nonAffineTransform.map(round);
    }
    const clipLayer = layer.maskFile
      ? { file: layer.maskFile, name: `${layer.name} mask` }
      : findClipLayer(layer, allLayersByTopIndex, scene);
    const clipFile = clipLayer?.file || clipLayer?.maskFile;
    if (clipFile) {
      item.clipMask = clipFile;
      item.clipMaskLeft = 0;
      item.clipMaskTop = 0;
      item.clipMaskWidth = Number(scene.width);
      item.clipMaskHeight = Number(scene.height);
      item.clipBaseName = clipLayer.name;
    }
  }
  return item;
}

function findClipLayer(replaceLayer, allLayersByTopIndex, scene) {
  const sameBoundsCandidates = [...allLayersByTopIndex.values()]
    .filter((layer) => isUsableClipLayer(layer, scene))
    .filter((layer) => boundsMatch(layer, replaceLayer, 3))
    .sort((left, right) => (
      Math.abs(left.topToBottomIndex - replaceLayer.topToBottomIndex)
      - Math.abs(right.topToBottomIndex - replaceLayer.topToBottomIndex)
    ));
  if (sameBoundsCandidates[0]) return sameBoundsCandidates[0];

  const adjacent = [replaceLayer.topToBottomIndex + 1, replaceLayer.topToBottomIndex - 1]
    .map((index) => allLayersByTopIndex.get(index))
    .find((layer) => isClipSource(layer, scene) && overlapRatio(layer, replaceLayer) > 0.15);
  if (adjacent) return adjacent;

  return [...allLayersByTopIndex.values()]
    .filter((layer) => isClipSource(layer, scene))
    .map((layer) => ({ layer, score: overlapRatio(layer, replaceLayer) }))
    .filter((item) => item.score > 0.35)
    .sort((left, right) => right.score - left.score)[0]?.layer;
}

function isUsableClipLayer(layer, scene) {
  return layer?.kind === "image"
    && Boolean(layer.file)
    && normalizeBlendMode(layer.blendMode) !== "linear_light"
    && !isFullSceneLayer(layer, scene);
}

function isClipSource(layer, scene) {
  if (isUsableClipLayer(layer, scene)) {
    return true;
  }
  return layer?.kind === "replace"
    && Boolean(layer.maskFile)
    && !isFullSceneLayer(layer, scene);
}

function boundsMatch(left, right, tolerance) {
  return Math.abs(Number(left.left) - Number(right.left)) <= tolerance
    && Math.abs(Number(left.top) - Number(right.top)) <= tolerance
    && Math.abs(Number(left.width) - Number(right.width)) <= tolerance
    && Math.abs(Number(left.height) - Number(right.height)) <= tolerance;
}

function isFullSceneLayer(layer, scene) {
  return Math.abs(Number(layer.left)) <= 2
    && Math.abs(Number(layer.top)) <= 2
    && Math.abs(Number(layer.width) - Number(scene.width)) <= 3
    && Math.abs(Number(layer.height) - Number(scene.height)) <= 3;
}

function overlapRatio(left, right) {
  const leftBox = boxFor(left);
  const rightBox = boxFor(right);
  const x1 = Math.max(leftBox.left, rightBox.left);
  const y1 = Math.max(leftBox.top, rightBox.top);
  const x2 = Math.min(leftBox.right, rightBox.right);
  const y2 = Math.min(leftBox.bottom, rightBox.bottom);
  const overlap = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const targetArea = Math.max(1, (rightBox.right - rightBox.left) * (rightBox.bottom - rightBox.top));
  return overlap / targetArea;
}

function boxFor(layer) {
  return {
    left: Number(layer.left || 0),
    top: Number(layer.top || 0),
    right: Number(layer.left || 0) + Number(layer.width || 0),
    bottom: Number(layer.top || 0) + Number(layer.height || 0),
  };
}

function normalizeBlendMode(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("linearlight")) return "linear_light";
  if (text.includes("multiply")) return "multiply";
  if (text.includes("screen")) return "screen";
  if (text.includes("overlay")) return "overlay";
  return "normal";
}

function metadataForSlug(value) {
  if (value === "ganfamao") {
    return {
      name: "\u5e72\u53d1\u5e3d\u6837\u673a",
      description: "\u9002\u5408 1:1 \u65b9\u5f62\u5e73\u9762\u56fe\uff0c\u751f\u6210\u5e72\u53d1\u5e3d\u3001\u6d74\u5e3d\u7c7b\u5546\u54c1\u6548\u679c\u56fe\u3002",
      productType: "\u5e72\u53d1\u5e3d / \u6d74\u5e3d",
      sourceAspectRatio: "1:1 \u65b9\u56fe",
    };
  }
  if (value === "zhuobu") {
    return {
      name: "\u684c\u5e03\u6837\u673a",
      description: "\u9002\u5408 3:2 \u6a2a\u56fe\u5e73\u9762\u56fe\uff0c\u751f\u6210\u684c\u5e03\u5ba4\u5185\u3001\u6237\u5916\u3001\u5c3a\u5bf8\u548c\u7ec6\u8282\u573a\u666f\u6548\u679c\u56fe\u3002",
      productType: "\u684c\u5e03 / \u9910\u684c\u5e03",
      sourceAspectRatio: "3:2 \u6a2a\u56fe",
      sourceWidth: 1600,
      sourceHeight: 960,
      sourceFit: "fill",
    };
  }
  if (value === "huazhuangbao") {
    return {
      name: "\u5316\u5986\u5305\u6837\u673a",
      description: "\u9002\u5408 4:3 \u6a2a\u56fe\u5e73\u9762\u56fe\uff0c\u751f\u6210\u5316\u5986\u5305\u591a\u89d2\u5ea6\u5957\u56fe\u6548\u679c\u56fe\u3002",
      productType: "\u5316\u5986\u5305 / \u6536\u7eb3\u5305",
      sourceAspectRatio: "4:3 \u6a2a\u56fe",
      sourceWidth: 1024,
      sourceHeight: 768,
      sourceFit: "fill",
    };
  }
  if (value === "shukoudai") {
    return {
      name: "\u675f\u53e3\u888b\u6837\u673a",
      description: "\u9002\u5408 3:4 \u7ad6\u56fe\u5e73\u9762\u56fe\uff0c\u751f\u6210\u675f\u53e3\u888b\u591a\u573a\u666f\u5546\u54c1\u6548\u679c\u56fe\u3002",
      productType: "\u675f\u53e3\u888b / \u6536\u7eb3\u888b / \u62bd\u7ef3\u888b",
      sourceAspectRatio: "3:4 \u7ad6\u56fe",
      sourceWidth: 768,
      sourceHeight: 1024,
      sourceFit: "fill",
    };
  }
  return {
    name: `${value} \u6837\u673a`,
    description: "\u9002\u5408 1:1 \u65b9\u5f62\u5e73\u9762\u56fe\u7684\u5546\u54c1\u6548\u679c\u56fe\u6837\u673a\u3002",
    productType: "",
    sourceAspectRatio: "1:1 \u65b9\u56fe",
  };
}

function round(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--slug") {
      parsed.slug = values[index + 1] || "";
      index += 1;
    } else if (value === "--export-dir") {
      parsed.exportDir = values[index + 1] || "";
      index += 1;
    } else if (value === "--target-dir") {
      parsed.targetDir = values[index + 1] || "";
      index += 1;
    }
  }
  return parsed;
}

async function pathExists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}
