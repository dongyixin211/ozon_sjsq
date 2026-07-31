import type { CloudAsset, CloudMockupAsset, CloudMockupTemplate } from "@shared/types";
import type { CloudClient, CloudMockupTemplatePackage, MockupTemplateJson } from "./cloudApi";

export type LocalMockupRenderResult = {
  ok: true;
  sourceAsset: {
    id: string;
    sku: string;
    sourceFilename: string;
  };
  template: CloudMockupTemplate;
  generated: number;
  assets: CloudMockupAsset[];
  renderer: "browser-canvas";
};

type TemplateScene = MockupTemplateJson["scenes"][number];
type TemplateLayer = TemplateScene["layers"][number];
type VisibleArea = {
  left: number;
  top: number;
  width: number;
  height: number;
  cropLeft: number;
  cropTop: number;
};

const templatePackageCache = new Map<string, { template: CloudMockupTemplatePackage; checkedAt: number }>();
const imageCache = new Map<string, Promise<HTMLImageElement>>();
const localObjectUrls = new Map<string, string>();
const rendererName = "browser-canvas";
const templatePackageStoragePrefix = "ozon-sjsq:mockup-template-package:v1:";
const templateAssetCacheName = "ozon-sjsq-mockup-template-assets-v1";
const localAssetUrlPrefix = "mockup-cache://";
const templatePackageRecheckMs = 5 * 60 * 1000;

export async function renderMockupLocallyAndUpload(input: {
  client: CloudClient;
  templateId: string;
  asset: CloudAsset;
}): Promise<LocalMockupRenderResult> {
  if (typeof document === "undefined") {
    throw new Error("当前环境不支持本地套图渲染");
  }
  const templatePackage = await loadTemplatePackage(input.client, input.templateId);
  const sourceImage = await loadSourceImage(input.client, input.asset);
  const preparedSource = prepareSourceImage(sourceImage, templatePackage.templateJson);
  const uploaded: CloudMockupAsset[] = [];
  const scenes = [...templatePackage.templateJson.scenes].sort((left, right) => left.index - right.index);
  for (const scene of scenes) {
    const canvas = await renderScene(templatePackage, scene, preparedSource);
    const blob = await canvasToBlob(canvas, contentTypeForTemplate(templatePackage.templateJson), templatePackage.templateJson.outputQuality);
    const filename = `${input.asset.sku}-${templatePackage.id}-${String(scene.index).padStart(2, "0")}.${extensionForTemplate(templatePackage.templateJson)}`;
    const result = await input.client.uploadLocalMockupResult({
      templateId: templatePackage.id,
      sourceAssetId: input.asset.id,
      sceneIndex: scene.index,
      filename,
      blob,
      clientRenderer: rendererName,
    });
    uploaded.push(result.asset);
  }
  return {
    ok: true,
    sourceAsset: {
      id: input.asset.id,
      sku: input.asset.sku,
      sourceFilename: input.asset.sourceFilename,
    },
    template: templatePackage,
    generated: uploaded.length,
    assets: uploaded,
    renderer: rendererName,
  };
}

async function loadTemplatePackage(client: CloudClient, templateId: string) {
  const cached = templatePackageCache.get(templateId);
  if (cached && Date.now() - cached.checkedAt < templatePackageRecheckMs) {
    return cached.template;
  }
  const stored = readStoredTemplatePackage(templateId);
  try {
    const result = await client.getMockupTemplatePackage(templateId);
    rememberTemplatePackage(templateId, result.template);
    writeStoredTemplatePackage(result.template);
    warmTemplateAssetCache(result.template).catch(() => undefined);
    return result.template;
  } catch (error) {
    if (cached) {
      return cached.template;
    }
    if (stored) {
      rememberTemplatePackage(templateId, stored);
      warmTemplateAssetCache(stored).catch(() => undefined);
      return stored;
    }
    throw error;
  }
}

function rememberTemplatePackage(templateId: string, template: CloudMockupTemplatePackage) {
  templatePackageCache.set(templateId, { template, checkedAt: Date.now() });
}

async function renderScene(
  templatePackage: CloudMockupTemplatePackage,
  scene: TemplateScene,
  source: HTMLCanvasElement,
) {
  const canvas = document.createElement("canvas");
  canvas.width = scene.width;
  canvas.height = scene.height;
  const context = requiredContext(canvas);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const layers = [...scene.layers].sort((left, right) => left.order - right.order);
  for (const layer of layers) {
    const rendered = await renderLayer(templatePackage, scene, layer, source);
    if (!rendered) {
      continue;
    }
    if (normalizeBlendMode(layer.blendMode) === "linear_light") {
      compositeLinearLight(canvas, rendered.canvas, rendered.left, rendered.top, resolveLinearLightStrength(layer, scene, templatePackage.templateJson));
      continue;
    }
    const blendMode = normalizeBlendMode(layer.blendMode);
    context.save();
    context.globalCompositeOperation = blendMode === "linear_light" ? "source-over" : blendMode;
    context.drawImage(rendered.canvas, rendered.left, rendered.top);
    context.restore();
  }
  return canvas;
}

async function renderLayer(
  templatePackage: CloudMockupTemplatePackage,
  scene: TemplateScene,
  layer: TemplateLayer,
  source: HTMLCanvasElement,
) {
  const visibleArea = getVisibleArea(layer, scene);
  if (!visibleArea) {
    return null;
  }
  if (layer.kind === "replace") {
    if (layer.uvMapX || layer.uvMapY) {
      throw new Error("本地套图暂不支持当前样机 UV 映射，已切换云端生成");
    }
    const canvas = layer.transform?.length === 8 && !isAxisAlignedTransform(layer.transform)
      ? renderPerspectiveReplacement(scene, layer, source)
      : renderFlatReplacement(layer, source, visibleArea);
    const masked = await applyLayerMasks(templatePackage, scene, layer, canvas, visibleArea, layer.transform?.length === 8 && !isAxisAlignedTransform(layer.transform));
    return {
      canvas: applyOpacity(masked, layer.opacity),
      left: layer.transform?.length === 8 && !isAxisAlignedTransform(layer.transform) ? 0 : visibleArea.left,
      top: layer.transform?.length === 8 && !isAxisAlignedTransform(layer.transform) ? 0 : visibleArea.top,
    };
  }
  if (!layer.file) {
    return null;
  }
  const image = await loadTemplateImage(templatePackage, layer.file);
  const layerCanvas = cropImageLayer(image, layer, visibleArea);
  return {
    canvas: applyOpacity(layerCanvas, layer.opacity),
    left: visibleArea.left,
    top: visibleArea.top,
  };
}

function prepareSourceImage(sourceImage: HTMLImageElement, template: MockupTemplateJson) {
  const { width, height, fit } = resolveSourceDimensions(template);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = requiredContext(canvas);
  drawImageFit(context, sourceImage, 0, 0, width, height, fit);
  return canvas;
}

function renderFlatReplacement(layer: TemplateLayer, source: HTMLCanvasElement, visibleArea: VisibleArea) {
  const full = document.createElement("canvas");
  full.width = Math.max(1, Math.round(layer.width));
  full.height = Math.max(1, Math.round(layer.height));
  const fullContext = requiredContext(full);
  drawSourceForLayer(fullContext, source, layer, 0, 0, full.width, full.height);
  const cropped = document.createElement("canvas");
  cropped.width = visibleArea.width;
  cropped.height = visibleArea.height;
  requiredContext(cropped).drawImage(full, visibleArea.cropLeft, visibleArea.cropTop, visibleArea.width, visibleArea.height, 0, 0, visibleArea.width, visibleArea.height);
  return cropped;
}

function renderPerspectiveReplacement(scene: TemplateScene, layer: TemplateLayer, source: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = scene.width;
  canvas.height = scene.height;
  const context = requiredContext(canvas);
  const points = transformToPoints(layer.transform ?? []);
  const bounds = targetBounds(points, scene.width, scene.height);
  const sourceCanvas = cropSourceForLayer(source, layer);
  const homography = homographyFromUnitSquare(points);
  const inverse = invertHomography(homography);
  if (!inverse) {
    throw new Error("本地套图暂不支持当前样机透视参数，已切换云端生成");
  }
  const output = context.createImageData(scene.width, scene.height);
  const sourceContext = requiredContext(sourceCanvas);
  const sourceData = sourceContext.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
  if (isValidPerspectiveMesh(layer.perspectiveMesh)) {
    for (const quad of layer.perspectiveMesh.quads) {
      const sourceTarget = quad.map((index) => layer.perspectiveMesh!.vertices[index]);
      const warpedTarget = quad.map((index) => layer.perspectiveMesh!.warpedVertices[index]);
      if (isPointQuad(sourceTarget) && isPointQuad(warpedTarget)) {
        renderPerspectiveQuadIntoImageData({
          output,
          sourceData,
          sourceTarget,
          warpedTarget,
          sampleMode: layer.sampleMode || "edge",
        });
      }
    }
  } else {
    renderPerspectiveQuadIntoImageData({
      output,
      sourceData,
      sourceTarget: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
        { x: 0, y: 1 },
      ],
      warpedTarget: points,
      sampleMode: layer.sampleMode || "edge",
    });
  }
  context.putImageData(output, 0, 0);
  return canvas;
}

async function applyLayerMasks(
  templatePackage: CloudMockupTemplatePackage,
  scene: TemplateScene,
  layer: TemplateLayer,
  canvas: HTMLCanvasElement,
  visibleArea: VisibleArea,
  fullSceneLayer: boolean,
) {
  let output = canvas;
  if (layer.mask) {
    const maskImage = await loadTemplateImage(templatePackage, layer.mask);
    const maskCanvas = hasPositionedMask(layer)
      ? buildPositionedMask(maskImage, scene, layer, fullSceneLayer ? undefined : visibleArea)
      : fullSceneLayer
      ? buildMaskOnScene(maskImage, scene, layer, visibleArea, true)
      : buildCroppedMask(maskImage, layer, visibleArea, "red");
    output = multiplyAlphaByMask(output, maskCanvas);
  }
  if (layer.clipMask) {
    const clipImage = await loadTemplateImage(templatePackage, layer.clipMask);
    const clipArea = getClipMaskVisibleArea(layer, scene, fullSceneLayer ? undefined : visibleArea);
    if (clipArea) {
      const clipCanvas = fullSceneLayer
        ? buildClipMaskOnScene(clipImage, scene, layer, clipArea)
        : buildClipMaskForVisibleLayer(clipImage, visibleArea, layer, clipArea);
      output = multiplyAlphaByMask(output, clipCanvas);
    }
  }
  return output;
}

function cropImageLayer(image: HTMLImageElement, layer: TemplateLayer, visibleArea: VisibleArea) {
  const full = document.createElement("canvas");
  full.width = Math.max(1, Math.round(layer.width));
  full.height = Math.max(1, Math.round(layer.height));
  requiredContext(full).drawImage(image, 0, 0, full.width, full.height);
  const cropped = document.createElement("canvas");
  cropped.width = visibleArea.width;
  cropped.height = visibleArea.height;
  requiredContext(cropped).drawImage(full, visibleArea.cropLeft, visibleArea.cropTop, visibleArea.width, visibleArea.height, 0, 0, visibleArea.width, visibleArea.height);
  return cropped;
}

function buildCroppedMask(image: HTMLImageElement, layer: TemplateLayer, visibleArea: VisibleArea, channel: "red" | "alpha") {
  const full = document.createElement("canvas");
  full.width = Math.max(1, Math.round(layer.width));
  full.height = Math.max(1, Math.round(layer.height));
  requiredContext(full).drawImage(image, 0, 0, full.width, full.height);
  const cropped = document.createElement("canvas");
  cropped.width = visibleArea.width;
  cropped.height = visibleArea.height;
  const context = requiredContext(cropped);
  context.drawImage(full, visibleArea.cropLeft, visibleArea.cropTop, visibleArea.width, visibleArea.height, 0, 0, visibleArea.width, visibleArea.height);
  return channelToAlphaMask(cropped, channel);
}

function buildMaskOnScene(image: HTMLImageElement, scene: TemplateScene, layer: TemplateLayer, visibleArea: VisibleArea, useRed: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = scene.width;
  canvas.height = scene.height;
  const context = requiredContext(canvas);
  context.drawImage(
    image,
    0,
    0,
    image.width,
    image.height,
    Math.round(layer.left),
    Math.round(layer.top),
    Math.max(1, Math.round(layer.width)),
    Math.max(1, Math.round(layer.height)),
  );
  if (visibleArea.left || visibleArea.top) {
    // Perspective layers already use scene-sized masks; keep the full coordinate system.
  }
  return channelToAlphaMask(canvas, useRed ? "red" : "alpha");
}

function buildPositionedMask(image: HTMLImageElement, scene: TemplateScene, layer: TemplateLayer, visibleArea?: VisibleArea) {
  const maskArea = getMaskVisibleArea(layer, scene, visibleArea);
  const canvas = document.createElement("canvas");
  canvas.width = visibleArea?.width ?? scene.width;
  canvas.height = visibleArea?.height ?? scene.height;
  if (!maskArea) {
    return channelToAlphaMask(canvas, "red");
  }
  const resized = document.createElement("canvas");
  resized.width = Math.max(1, Math.round(layer.maskWidth ?? layer.width));
  resized.height = Math.max(1, Math.round(layer.maskHeight ?? layer.height));
  requiredContext(resized).drawImage(image, 0, 0, resized.width, resized.height);
  requiredContext(canvas).drawImage(
    resized,
    maskArea.cropLeft,
    maskArea.cropTop,
    maskArea.width,
    maskArea.height,
    maskArea.left,
    maskArea.top,
    maskArea.width,
    maskArea.height,
  );
  return channelToAlphaMask(canvas, "red");
}

function buildClipMaskOnScene(image: HTMLImageElement, scene: TemplateScene, layer: TemplateLayer, clipArea: VisibleArea) {
  const resized = document.createElement("canvas");
  resized.width = Math.max(1, Math.round(layer.clipMaskWidth ?? layer.width));
  resized.height = Math.max(1, Math.round(layer.clipMaskHeight ?? layer.height));
  requiredContext(resized).drawImage(image, 0, 0, resized.width, resized.height);
  const canvas = document.createElement("canvas");
  canvas.width = scene.width;
  canvas.height = scene.height;
  requiredContext(canvas).drawImage(
    resized,
    clipArea.cropLeft,
    clipArea.cropTop,
    clipArea.width,
    clipArea.height,
    clipArea.left,
    clipArea.top,
    clipArea.width,
    clipArea.height,
  );
  return channelToAlphaMask(canvas, "alpha");
}

function buildClipMaskForVisibleLayer(image: HTMLImageElement, visibleArea: VisibleArea, layer: TemplateLayer, clipArea: VisibleArea) {
  const resized = document.createElement("canvas");
  resized.width = Math.max(1, Math.round(layer.clipMaskWidth ?? layer.width));
  resized.height = Math.max(1, Math.round(layer.clipMaskHeight ?? layer.height));
  requiredContext(resized).drawImage(image, 0, 0, resized.width, resized.height);
  const canvas = document.createElement("canvas");
  canvas.width = visibleArea.width;
  canvas.height = visibleArea.height;
  requiredContext(canvas).drawImage(resized, clipArea.cropLeft, clipArea.cropTop, clipArea.width, clipArea.height, clipArea.left, clipArea.top, clipArea.width, clipArea.height);
  return channelToAlphaMask(canvas, "alpha");
}

function channelToAlphaMask(canvas: HTMLCanvasElement, channel: "red" | "alpha") {
  const context = requiredContext(canvas);
  const data = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let offset = 0; offset < data.data.length; offset += 4) {
    const value = channel === "red" ? data.data[offset] : data.data[offset + 3];
    data.data[offset] = value;
    data.data[offset + 1] = value;
    data.data[offset + 2] = value;
    data.data[offset + 3] = 255;
  }
  context.putImageData(data, 0, 0);
  return canvas;
}

function multiplyAlphaByMask(layer: HTMLCanvasElement, mask: HTMLCanvasElement) {
  const output = cloneCanvas(layer);
  const context = requiredContext(output);
  const layerData = context.getImageData(0, 0, output.width, output.height);
  const maskCanvas = resizeCanvas(mask, output.width, output.height);
  const maskData = requiredContext(maskCanvas).getImageData(0, 0, output.width, output.height);
  for (let offset = 0; offset < layerData.data.length; offset += 4) {
    layerData.data[offset + 3] = Math.round((layerData.data[offset + 3] * maskData.data[offset]) / 255);
  }
  context.putImageData(layerData, 0, 0);
  return output;
}

function applyOpacity(canvas: HTMLCanvasElement, opacity = 1) {
  const normalized = Math.min(1, Math.max(0, opacity));
  if (normalized >= 1) {
    return canvas;
  }
  const output = cloneCanvas(canvas);
  const context = requiredContext(output);
  const data = context.getImageData(0, 0, output.width, output.height);
  for (let offset = 3; offset < data.data.length; offset += 4) {
    data.data[offset] = Math.round(data.data[offset] * normalized);
  }
  context.putImageData(data, 0, 0);
  return output;
}

function compositeLinearLight(base: HTMLCanvasElement, layer: HTMLCanvasElement, left: number, top: number, strength: number) {
  const context = requiredContext(base);
  const baseData = context.getImageData(0, 0, base.width, base.height);
  const layerData = requiredContext(layer).getImageData(0, 0, layer.width, layer.height);
  const startX = Math.max(0, left);
  const startY = Math.max(0, top);
  const endX = Math.min(base.width, left + layer.width);
  const endY = Math.min(base.height, top + layer.height);
  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const baseOffset = (y * base.width + x) * 4;
      const layerX = x - left;
      const layerY = y - top;
      const layerOffset = (layerY * layer.width + layerX) * 4;
      const alpha = layerData.data[layerOffset + 3] / 255;
      if (alpha <= 0) continue;
      for (let channel = 0; channel < 3; channel += 1) {
        const blended = clampByte(baseData.data[baseOffset + channel] + (2 * layerData.data[layerOffset + channel] - 255) * strength);
        baseData.data[baseOffset + channel] = Math.round(blended * alpha + baseData.data[baseOffset + channel] * (1 - alpha));
      }
      baseData.data[baseOffset + 3] = 255;
    }
  }
  context.putImageData(baseData, 0, 0);
}

function drawSourceForLayer(
  context: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  layer: TemplateLayer,
  left: number,
  top: number,
  width: number,
  height: number,
) {
  const crop = normalizeSourceCrop(layer.sourceCrop, source.width, source.height);
  context.drawImage(source, crop.left, crop.top, crop.width, crop.height, left, top, width, height);
}

function cropSourceForLayer(source: HTMLCanvasElement, layer: TemplateLayer) {
  const crop = normalizeSourceCrop(layer.sourceCrop, source.width, source.height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(layer.width));
  canvas.height = Math.max(1, Math.round(layer.height));
  requiredContext(canvas).drawImage(source, crop.left, crop.top, crop.width, crop.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function normalizeSourceCrop(crop: TemplateLayer["sourceCrop"], width: number, height: number) {
  if (!crop) {
    return { left: 0, top: 0, width, height };
  }
  const left = Math.max(0, Math.min(width - 1, Math.round(crop.left)));
  const top = Math.max(0, Math.min(height - 1, Math.round(crop.top)));
  const right = Math.max(left + 1, Math.min(width, Math.round(crop.left + crop.width)));
  const bottom = Math.max(top + 1, Math.min(height, Math.round(crop.top + crop.height)));
  return { left, top, width: right - left, height: bottom - top };
}

async function loadTemplateImage(templatePackage: CloudMockupTemplatePackage, file: string) {
  const url = templatePackage.assetUrls[file];
  if (!url) {
    throw new Error(`样机模板缺少资源：${file}`);
  }
  return loadImage(await resolveTemplateAssetUrl(templatePackage, file, url));
}

function loadImage(url: string) {
  const cached = imageCache.get(url);
  if (cached) {
    return cached;
  }
  const promise = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => {
      imageCache.delete(url);
      reject(new Error(`图片加载失败：${displayImageUrl(url)}`));
    };
    image.src = url;
  });
  imageCache.set(url, promise);
  return promise;
}

async function loadSourceImage(client: CloudClient, asset: CloudAsset) {
  let objectUrl = "";
  try {
    const blob = await client.downloadAssetOriginal(asset.id);
    objectUrl = URL.createObjectURL(blob);
    return await loadImage(objectUrl);
  } catch {
    return loadImage(asset.publicUrl);
  } finally {
    if (objectUrl) {
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
    }
  }
}

function drawImageFit(
  context: CanvasRenderingContext2D,
  image: CanvasImageSource,
  left: number,
  top: number,
  width: number,
  height: number,
  fit: "cover" | "fill",
) {
  if (fit === "fill") {
    context.drawImage(image, left, top, width, height);
    return;
  }
  const sourceWidth = image instanceof HTMLCanvasElement || image instanceof HTMLImageElement ? image.width : width;
  const sourceHeight = image instanceof HTMLCanvasElement || image instanceof HTMLImageElement ? image.height : height;
  const scale = Math.max(width / sourceWidth, height / sourceHeight);
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  context.drawImage(image, left + (width - drawWidth) / 2, top + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function resolveSourceDimensions(template: MockupTemplateJson) {
  if (template.sourceWidth && template.sourceHeight) {
    return {
      width: clampSourceDimension(template.sourceWidth),
      height: clampSourceDimension(template.sourceHeight),
      fit: template.sourceFit === "fill" ? "fill" as const : "cover" as const,
    };
  }
  const size = clampSourceDimension(template.sourceSize || 1024);
  return { width: size, height: size, fit: "cover" as const };
}

function clampSourceDimension(value: number) {
  return Math.max(256, Math.min(4096, Math.round(value)));
}

function getVisibleArea(layer: TemplateLayer, scene: TemplateScene): VisibleArea | null {
  const layerLeft = Math.round(layer.left);
  const layerTop = Math.round(layer.top);
  const layerWidth = Math.max(1, Math.round(layer.width));
  const layerHeight = Math.max(1, Math.round(layer.height));
  const left = Math.max(0, layerLeft);
  const top = Math.max(0, layerTop);
  const right = Math.min(scene.width, layerLeft + layerWidth);
  const bottom = Math.min(scene.height, layerTop + layerHeight);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return { left, top, width, height, cropLeft: left - layerLeft, cropTop: top - layerTop };
}

function getClipMaskVisibleArea(layer: TemplateLayer, scene: TemplateScene, visibleArea?: VisibleArea): VisibleArea | null {
  const maskLeft = Math.round(layer.clipMaskLeft ?? layer.left);
  const maskTop = Math.round(layer.clipMaskTop ?? layer.top);
  const maskWidth = Math.max(1, Math.round(layer.clipMaskWidth ?? layer.width));
  const maskHeight = Math.max(1, Math.round(layer.clipMaskHeight ?? layer.height));
  return getPositionedMaskVisibleArea(scene, visibleArea, maskLeft, maskTop, maskWidth, maskHeight);
}

function getMaskVisibleArea(layer: TemplateLayer, scene: TemplateScene, visibleArea?: VisibleArea): VisibleArea | null {
  const maskLeft = Math.round(layer.maskLeft ?? layer.left);
  const maskTop = Math.round(layer.maskTop ?? layer.top);
  const maskWidth = Math.max(1, Math.round(layer.maskWidth ?? layer.width));
  const maskHeight = Math.max(1, Math.round(layer.maskHeight ?? layer.height));
  return getPositionedMaskVisibleArea(scene, visibleArea, maskLeft, maskTop, maskWidth, maskHeight);
}

function getPositionedMaskVisibleArea(
  scene: TemplateScene,
  visibleArea: VisibleArea | undefined,
  maskLeft: number,
  maskTop: number,
  maskWidth: number,
  maskHeight: number,
): VisibleArea | null {
  const outputLeft = visibleArea?.left ?? 0;
  const outputTop = visibleArea?.top ?? 0;
  const outputRight = outputLeft + (visibleArea?.width ?? scene.width);
  const outputBottom = outputTop + (visibleArea?.height ?? scene.height);
  const left = Math.max(outputLeft, maskLeft, 0);
  const top = Math.max(outputTop, maskTop, 0);
  const right = Math.min(outputRight, maskLeft + maskWidth, scene.width);
  const bottom = Math.min(outputBottom, maskTop + maskHeight, scene.height);
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return null;
  return {
    left: visibleArea ? left - outputLeft : left,
    top: visibleArea ? top - outputTop : top,
    width,
    height,
    cropLeft: left - maskLeft,
    cropTop: top - maskTop,
  };
}

function hasPositionedMask(layer: TemplateLayer) {
  return layer.maskLeft !== undefined
    || layer.maskTop !== undefined
    || layer.maskWidth !== undefined
    || layer.maskHeight !== undefined;
}

function normalizeBlendMode(value?: string): GlobalCompositeOperation | "linear_light" {
  if (!value || value === "normal") return "source-over";
  if (value === "linear_light") return "linear_light";
  const map: Record<string, GlobalCompositeOperation> = {
    multiply: "multiply",
    screen: "screen",
    overlay: "overlay",
    darken: "darken",
    lighten: "lighten",
    color_dodge: "color-dodge",
    colour_dodge: "color-dodge",
    color_burn: "color-burn",
    colour_burn: "color-burn",
    hard_light: "hard-light",
    soft_light: "soft-light",
    difference: "difference",
    exclusion: "exclusion",
  };
  return map[value] ?? "source-over";
}

function resolveLinearLightStrength(layer: TemplateLayer, scene: TemplateScene, template: MockupTemplateJson) {
  return firstFinite(layer.blendStrength, scene.linearLightStrength, template.linearLightStrength, layer.opacity === 0 ? 0 : undefined, 1);
}

function firstFinite(...values: Array<number | undefined>) {
  for (const value of values) {
    if (value !== undefined && Number.isFinite(value)) return value;
  }
  return 0;
}

type Point = { x: number; y: number };
type Homography = { a: number; b: number; c: number; d: number; e: number; f: number; g: number; h: number };
type InverseHomography = { m00: number; m01: number; m02: number; m10: number; m11: number; m12: number; m20: number; m21: number; m22: number };

function transformToPoints(values: number[]): [Point, Point, Point, Point] {
  return [
    { x: values[0], y: values[1] },
    { x: values[2], y: values[3] },
    { x: values[4], y: values[5] },
    { x: values[6], y: values[7] },
  ];
}

function isAxisAlignedTransform(values: number[]) {
  const [x1, y1, x2, y2, x3, y3, x4, y4] = values;
  const tolerance = 0.8;
  return Math.abs(y1 - y2) <= tolerance
    && Math.abs(x2 - x3) <= tolerance
    && Math.abs(y3 - y4) <= tolerance
    && Math.abs(x4 - x1) <= tolerance;
}

function targetBounds(points: [Point, Point, Point, Point], sceneWidth: number, sceneHeight: number) {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  return {
    left: Math.max(0, Math.floor(Math.min(...xs))),
    top: Math.max(0, Math.floor(Math.min(...ys))),
    right: Math.min(sceneWidth, Math.ceil(Math.max(...xs))),
    bottom: Math.min(sceneHeight, Math.ceil(Math.max(...ys))),
  };
}

function isValidPerspectiveMesh(value: TemplateLayer["perspectiveMesh"]): value is NonNullable<TemplateLayer["perspectiveMesh"]> {
  return Boolean(
    value
    && Array.isArray(value.vertices)
    && Array.isArray(value.warpedVertices)
    && Array.isArray(value.quads)
    && value.vertices.length === value.warpedVertices.length
    && value.vertices.every(isPoint)
    && value.warpedVertices.every(isPoint)
    && value.quads.every((quad) => (
      Array.isArray(quad)
      && quad.length === 4
      && quad.every((index) => Number.isInteger(index) && index >= 0 && index < value.vertices.length)
    )),
  );
}

function isPoint(value: Point | undefined): value is Point {
  return Boolean(value && Number.isFinite(value.x) && Number.isFinite(value.y));
}

function isPointQuad(points: Point[]): points is [Point, Point, Point, Point] {
  return points.length === 4 && points.every(isPoint);
}

function homographyFromUnitSquare(points: [Point, Point, Point, Point]): Homography {
  const [topLeft, topRight, bottomRight, bottomLeft] = points;
  const dx1 = topRight.x - bottomRight.x;
  const dy1 = topRight.y - bottomRight.y;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const denominator = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(denominator) < 0.000001) {
    return { a: topRight.x - topLeft.x, b: bottomLeft.x - topLeft.x, c: topLeft.x, d: topRight.y - topLeft.y, e: bottomLeft.y - topLeft.y, f: topLeft.y, g: 0, h: 0 };
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

function invertHomography(matrix: Homography): InverseHomography | null {
  const m00 = matrix.a;
  const m01 = matrix.b;
  const m02 = matrix.c;
  const m10 = matrix.d;
  const m11 = matrix.e;
  const m12 = matrix.f;
  const m20 = matrix.g;
  const m21 = matrix.h;
  const m22 = 1;
  const determinant = m00 * (m11 * m22 - m12 * m21)
    - m01 * (m10 * m22 - m12 * m20)
    + m02 * (m10 * m21 - m11 * m20);
  if (Math.abs(determinant) < 0.000001) return null;
  const inv = 1 / determinant;
  return {
    m00: (m11 * m22 - m12 * m21) * inv,
    m01: (m02 * m21 - m01 * m22) * inv,
    m02: (m01 * m12 - m02 * m11) * inv,
    m10: (m12 * m20 - m10 * m22) * inv,
    m11: (m00 * m22 - m02 * m20) * inv,
    m12: (m02 * m10 - m00 * m12) * inv,
    m20: (m10 * m21 - m11 * m20) * inv,
    m21: (m01 * m20 - m00 * m21) * inv,
    m22: (m00 * m11 - m01 * m10) * inv,
  };
}

function mapTargetToUnit(inverse: InverseHomography, x: number, y: number) {
  const denominator = inverse.m20 * x + inverse.m21 * y + inverse.m22;
  if (Math.abs(denominator) < 0.000001) return null;
  return {
    u: (inverse.m00 * x + inverse.m01 * y + inverse.m02) / denominator,
    v: (inverse.m10 * x + inverse.m11 * y + inverse.m12) / denominator,
  };
}

function renderPerspectiveQuadIntoImageData(input: {
  output: ImageData;
  sourceData: ImageData;
  sourceTarget: [Point, Point, Point, Point];
  warpedTarget: [Point, Point, Point, Point];
  sampleMode: "edge" | "center" | string;
}) {
  const bounds = targetBounds(input.warpedTarget, input.output.width, input.output.height);
  const sourceHomography = homographyFromUnitSquare(input.sourceTarget);
  const warpedHomography = homographyFromUnitSquare(input.warpedTarget);
  const inverseWarpedHomography = invertHomography(warpedHomography);
  if (!inverseWarpedHomography) return;
  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const uv = mapTargetToUnit(inverseWarpedHomography, x + 0.5, y + 0.5);
      if (!uv || uv.u < -0.001 || uv.u > 1.001 || uv.v < -0.001 || uv.v > 1.001) {
        continue;
      }
      const sourceUnit = mapUnitToTarget(sourceHomography, uv.u, uv.v);
      const sx = mapCoordinateToSourcePixel(sourceUnit.x, input.sourceData.width, input.sampleMode);
      const sy = mapCoordinateToSourcePixel(sourceUnit.y, input.sourceData.height, input.sampleMode);
      const [r, g, b, a] = sampleBilinear(input.sourceData, sx, sy);
      const offset = (y * input.output.width + x) * 4;
      input.output.data[offset] = r;
      input.output.data[offset + 1] = g;
      input.output.data[offset + 2] = b;
      input.output.data[offset + 3] = a;
    }
  }
}

function mapUnitToTarget(homography: Homography, u: number, v: number): Point {
  const denominator = homography.g * u + homography.h * v + 1;
  if (Math.abs(denominator) < 0.000001) {
    return { x: 0, y: 0 };
  }
  return {
    x: (homography.a * u + homography.b * v + homography.c) / denominator,
    y: (homography.d * u + homography.e * v + homography.f) / denominator,
  };
}

function mapCoordinateToSourcePixel(value: number, size: number, sampleMode: string) {
  if (sampleMode === "center") {
    return Math.max(0, Math.min(size - 1, value * size - 0.5));
  }
  return Math.max(0, Math.min(size - 1, value * (size - 1)));
}

function sampleBilinear(imageData: ImageData, x: number, y: number): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(imageData.width - 1, x0 + 1);
  const y1 = Math.min(imageData.height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const p00 = readPixel(imageData, x0, y0);
  const p10 = readPixel(imageData, x1, y0);
  const p01 = readPixel(imageData, x0, y1);
  const p11 = readPixel(imageData, x1, y1);
  return [0, 1, 2, 3].map((channel) => {
    const top = p00[channel] * (1 - tx) + p10[channel] * tx;
    const bottom = p01[channel] * (1 - tx) + p11[channel] * tx;
    return Math.round(top * (1 - ty) + bottom * ty);
  }) as [number, number, number, number];
}

function readPixel(imageData: ImageData, x: number, y: number): [number, number, number, number] {
  const offset = (y * imageData.width + x) * 4;
  return [
    imageData.data[offset],
    imageData.data[offset + 1],
    imageData.data[offset + 2],
    imageData.data[offset + 3],
  ];
}

function resizeCanvas(source: HTMLCanvasElement, width: number, height: number) {
  if (source.width === width && source.height === height) return source;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  requiredContext(canvas).drawImage(source, 0, 0, width, height);
  return canvas;
}

function cloneCanvas(source: HTMLCanvasElement) {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  requiredContext(canvas).drawImage(source, 0, 0);
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("本地套图导出失败"));
    }, type, quality ? Math.min(1, Math.max(0.1, quality / 100)) : undefined);
  });
}

function readStoredTemplatePackage(templateId: string) {
  if (typeof window === "undefined") {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(templatePackageStorageKey(templateId));
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as CloudMockupTemplatePackage;
    if (!parsed?.id || !parsed.templateJson || !parsed.assetUrls) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeStoredTemplatePackage(templatePackage: CloudMockupTemplatePackage) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(templatePackageStorageKey(templatePackage.id), JSON.stringify(templatePackage));
  } catch {
    // localStorage may be full; the in-memory cache still keeps the current run fast.
  }
}

function templatePackageStorageKey(templateId: string) {
  return `${templatePackageStoragePrefix}${templateId}`;
}

async function warmTemplateAssetCache(templatePackage: CloudMockupTemplatePackage) {
  if (!("caches" in window)) {
    return;
  }
  const cache = await window.caches.open(templateAssetCacheName);
  const urls = [...new Set(Object.values(templatePackage.assetUrls).filter(Boolean))];
  await Promise.all(urls.map(async (url) => {
    const key = templateAssetCacheKey(templatePackage, url);
    if (await cache.match(key)) {
      return;
    }
    try {
      const response = await fetch(url, { credentials: "include", cache: "force-cache" });
      if (response.ok) {
        await cache.put(key, response);
      }
    } catch {
      // Keep rendering resilient; a failed pre-cache can still be loaded through the normal image path.
    }
  }));
}

async function resolveTemplateAssetUrl(templatePackage: CloudMockupTemplatePackage, file: string, url: string) {
  const localKey = `${templatePackage.id}:${templatePackage.version}:${file}`;
  const objectUrl = localObjectUrls.get(localKey);
  if (objectUrl) {
    return objectUrl;
  }
  if (!("caches" in window)) {
    return url;
  }
  try {
    const cache = await window.caches.open(templateAssetCacheName);
    const key = templateAssetCacheKey(templatePackage, url);
    let response = await cache.match(key);
    if (!response) {
      const fetched = await fetch(url, { credentials: "include", cache: "force-cache" });
      if (fetched.ok) {
        await cache.put(key, fetched.clone());
        response = fetched;
      }
    }
    if (!response?.ok) {
      return url;
    }
    const blob = await response.blob();
    const nextObjectUrl = URL.createObjectURL(blob);
    localObjectUrls.set(localKey, nextObjectUrl);
    return nextObjectUrl;
  } catch {
    return url;
  }
}

function templateAssetCacheKey(templatePackage: CloudMockupTemplatePackage, url: string) {
  return `${location.origin}/__mockup_template_cache__/${encodeURIComponent(templatePackage.id)}/${encodeURIComponent(templatePackage.version || "latest")}/${encodeURIComponent(url)}`;
}

function displayImageUrl(url: string) {
  if (url.startsWith(localAssetUrlPrefix) || url.startsWith("blob:")) {
    return "客户端样机缓存";
  }
  return url;
}

function contentTypeForTemplate(template: MockupTemplateJson) {
  if (template.outputFormat === "webp") return "image/webp";
  if (template.outputFormat === "jpeg") return "image/jpeg";
  return "image/png";
}

function extensionForTemplate(template: MockupTemplateJson) {
  if (template.outputFormat === "webp") return "webp";
  if (template.outputFormat === "jpeg") return "jpg";
  return "png";
}

function requiredContext(canvas: HTMLCanvasElement) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    throw new Error("当前浏览器不支持本地套图渲染");
  }
  return context;
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, value));
}
