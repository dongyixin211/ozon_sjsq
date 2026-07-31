import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp, { type Blend } from "sharp";
import { config } from "./config.js";
import { AppError } from "./errors.js";

type TemplateLayer = {
  order: number;
  left: number;
  top: number;
  width: number;
  height: number;
  opacity?: number;
  blendStrength?: number;
  blendMode?: string;
  kind: "image" | "replace";
  file?: string;
  transform?: number[];
  psTransform?: number[];
  nonAffineTransform?: number[];
  perspectiveMesh?: PerspectiveMesh;
  uvMapX?: string;
  uvMapY?: string;
  uvMapEncoding?: "rg16" | "r8";
  sampleMode?: PerspectiveSampleMode;
  interpolation?: PerspectiveInterpolation;
  replacementResizeKernel?: SourceResizeKernel;
  sourceCrop?: SourceCrop;
  edgeFeather?: number;
  colorCorrection?: LayerColorCorrection;
  pixelOffsetX?: number;
  pixelOffsetY?: number;
  mask?: string;
  maskLeft?: number;
  maskTop?: number;
  maskWidth?: number;
  maskHeight?: number;
  clipToLayerOrder?: number;
  clipMask?: string;
  clipMaskLeft?: number;
  clipMaskTop?: number;
  clipMaskWidth?: number;
  clipMaskHeight?: number;
};

type TemplateScene = {
  id: string;
  index: number;
  width: number;
  height: number;
  pixelOffsetX?: number;
  pixelOffsetY?: number;
  outputOffsetX?: number;
  outputOffsetY?: number;
  replacementResizeKernel?: SourceResizeKernel;
  linearLightStrength?: number;
  layers: TemplateLayer[];
};

type MockupTemplate = {
  id: string;
  name: string;
  outputWidth: number;
  outputHeight: number;
  outputFormat: "jpeg" | "png" | "webp";
  outputQuality: number;
  outputChromaSubsampling?: "4:2:0" | "4:4:4";
  outputMozjpeg?: boolean;
  description?: string;
  productType?: string;
  sourceAspectRatio?: string;
  previewPath?: string;
  sourceSize?: number;
  sourceWidth?: number;
  sourceHeight?: number;
  sourceFit?: "cover" | "fill";
  sourceResizeKernel?: SourceResizeKernel;
  replacementResizeKernel?: SourceResizeKernel;
  linearLightStrength?: number;
  scenes: TemplateScene[];
};

export type RenderedMockupScene = {
  index: number;
  filename: string;
  buffer: Buffer;
  contentType: string;
};

type LayerBlend = Blend | "linear_light";

type RenderedLayer = {
  input: Buffer;
  left: number;
  top: number;
  blend: LayerBlend;
  blendStrength?: number;
};

type RenderOptions = {
  perspectivePixelOffsetX?: number;
  perspectivePixelOffsetY?: number;
  perspectiveSampleMode?: PerspectiveSampleMode;
  perspectiveInterpolation?: PerspectiveInterpolation;
  replacementResizeKernel?: SourceResizeKernel;
  linearLightStrength?: number;
  templateLinearLightStrength?: number;
  sceneIndexes?: number[];
};

type PreparedSourceImage = {
  buffer: Buffer;
  data: Buffer;
  width: number;
  height: number;
};

type SourceResizeKernel = "nearest" | "cubic" | "mitchell" | "lanczos2" | "lanczos3";
type SourceCrop = {
  left: number;
  top: number;
  width: number;
  height: number;
};
type LayerColorCorrection = {
  red?: ChannelColorCorrection;
  green?: ChannelColorCorrection;
  blue?: ChannelColorCorrection;
  strength?: number;
};
type ChannelColorCorrection = {
  scale?: number;
  offset?: number;
};
type PerspectiveMesh = {
  vertices: Point[];
  warpedVertices: Point[];
  quads: number[][];
};
type PerspectiveSampleMode = "edge" | "center";
type PerspectiveInterpolation =
  | "nearest"
  | "bilinear"
  | "bicubic"
  | "bicubic-ps"
  | "bicubic-soft"
  | "mitchell"
  | "lanczos2"
  | "lanczos3"
  | "supersample2"
  | "supersample3"
  | "supersample4"
  | "supersample5";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockupTemplatesRoot = config.MOCKUP_TEMPLATE_ROOT
  ? path.resolve(config.MOCKUP_TEMPLATE_ROOT)
  : path.join(__dirname, "mockup-templates");
const builtinFangjinTemplateDir = "fangjin";
const cachedTemplates = new Map<string, MockupTemplate>();
const cachedImageLayers = new Map<string, Buffer>();
const mockupSourceSize = 1024;
const linearLightStrength = readNumberEnv("MOCKUP_LINEAR_LIGHT_STRENGTH", 1);
const perspectiveSampleMode = process.env.MOCKUP_PERSPECTIVE_SAMPLE_MODE || "";
const perspectiveInterpolation = process.env.MOCKUP_PERSPECTIVE_INTERPOLATION || "";
const defaultPerspectivePixelOffsetX = -0.1875;
const defaultPerspectivePixelOffsetY = -0.5;
const perspectivePixelOffset = readNumberEnv("MOCKUP_PERSPECTIVE_PIXEL_OFFSET", Number.NaN);
const perspectivePixelOffsetX = readNumberEnv("MOCKUP_PERSPECTIVE_PIXEL_OFFSET_X", perspectivePixelOffset);
const perspectivePixelOffsetY = readNumberEnv("MOCKUP_PERSPECTIVE_PIXEL_OFFSET_Y", perspectivePixelOffset);
const outputChromaSubsampling = process.env.MOCKUP_OUTPUT_CHROMA_SUBSAMPLING || "";
const outputMozjpeg = process.env.MOCKUP_OUTPUT_MOZJPEG || "";
const sourceSize = readNumberEnv("MOCKUP_SOURCE_SIZE", Number.NaN);
const sourceWidth = readNumberEnv("MOCKUP_SOURCE_WIDTH", Number.NaN);
const sourceHeight = readNumberEnv("MOCKUP_SOURCE_HEIGHT", Number.NaN);
const sourceResizeKernel = process.env.MOCKUP_SOURCE_RESIZE_KERNEL || "";
const replacementResizeKernel = process.env.MOCKUP_REPLACEMENT_RESIZE_KERNEL || "";
const sceneFilter = readSceneFilterEnv();
const sceneRenderConcurrency = Math.max(1, Math.min(4, readNumberEnv("MOCKUP_SCENE_CONCURRENCY", 2)));

export function invalidateMockupTemplateCache(templateDir?: string) {
  if (!templateDir) {
    cachedTemplates.clear();
    cachedImageLayers.clear();
    return;
  }
  const normalizedTemplateDir = normalizeTemplateDir(templateDir);
  cachedTemplates.delete(normalizedTemplateDir);
  const prefix = `${normalizedTemplateDir}/`;
  for (const key of cachedImageLayers.keys()) {
    if (key.startsWith(prefix)) {
      cachedImageLayers.delete(key);
    }
  }
}

export async function renderMockupsWithTemplate(input: {
  templateDir: string;
  sourceBuffer: Buffer;
  sku: string;
} & RenderOptions) {
  const template = await readTemplate(input.templateDir);
  const preparedSource = await createPreparedSource(input.sourceBuffer, template);
  const rendered: RenderedMockupScene[] = [];
  const renderOptions: RenderOptions = {
    perspectivePixelOffsetX: input.perspectivePixelOffsetX,
    perspectivePixelOffsetY: input.perspectivePixelOffsetY,
    perspectiveSampleMode: input.perspectiveSampleMode,
    perspectiveInterpolation: input.perspectiveInterpolation,
    replacementResizeKernel: input.replacementResizeKernel,
    linearLightStrength: input.linearLightStrength,
    templateLinearLightStrength: template.linearLightStrength,
    sceneIndexes: input.sceneIndexes,
  };
  const requestedSceneIndexes = input.sceneIndexes?.length ? new Set(input.sceneIndexes) : sceneFilter;

  const targetScenes = template.scenes.filter((scene) => !requestedSceneIndexes || requestedSceneIndexes.has(scene.index));
  await mapWithConcurrency(targetScenes, sceneRenderConcurrency, async (scene) => {
    const image = sharp(await renderSceneBuffer(input.templateDir, scene, preparedSource, renderOptions));

    const buffer = await outputBuffer(image, template);
    rendered.push({
      index: scene.index,
      filename: `${input.sku}-${publicTemplateId(template, input.templateDir)}-${String(scene.index).padStart(2, "0")}.${extensionForTemplate(template)}`,
      buffer,
      contentType: contentTypeForTemplate(template),
    });
  });
  rendered.sort((left, right) => left.index - right.index);

  return {
    template: {
      id: publicTemplateId(template, input.templateDir),
      name: template.name || "鏂瑰肪鏍锋満",
      description: template.description || "Square image mockup template",
      productType: template.productType || "鏂瑰肪",
      sourceAspectRatio: template.sourceAspectRatio || "1:1",
      status: "system",
      previewUrl: template.previewPath || `/mockup-template-assets/${encodeURIComponent(input.templateDir)}/preview.png`,
      sceneCount: template.scenes.length,
      outputWidth: template.outputWidth,
      outputHeight: template.outputHeight,
    },
    scenes: rendered,
  };
}

export async function renderFangjinMockups(input: { sourceBuffer: Buffer; sku: string } & RenderOptions) {
  return renderMockupsWithTemplate({ ...input, templateDir: builtinFangjinTemplateDir });
}

export async function getFangjinMockupTemplateInfo() {
  return getMockupTemplateInfo(builtinFangjinTemplateDir);
}

export async function getMockupTemplateInfo(templateDir: string) {
  const template = await readTemplate(templateDir);
  return templateInfo(template, templateDir);
}

function templateInfo(template: MockupTemplate, templateDir: string) {
  return {
    id: publicTemplateId(template, templateDir),
    templateId: template.id,
    name: template.name || "鏂瑰肪鏍锋満",
    description: template.description || "Square image mockup template",
    productType: template.productType || "鏂瑰肪",
    sourceAspectRatio: template.sourceAspectRatio || "1:1",
    status: "system",
    previewUrl: template.previewPath || `/mockup-template-assets/${encodeURIComponent(templateDir)}/preview.png`,
    sceneCount: template.scenes.length,
    outputWidth: template.outputWidth,
    outputHeight: template.outputHeight,
  };
}

async function readTemplate(templateDir: string) {
  const normalizedTemplateDir = normalizeTemplateDir(templateDir);
  const cachedTemplate = cachedTemplates.get(normalizedTemplateDir);
  if (cachedTemplate) {
    return cachedTemplate;
  }
  const raw = await fs.readFile(path.join(mockupTemplatesRoot, normalizedTemplateDir, "template.json"), "utf8");
  const template = JSON.parse(raw) as MockupTemplate;
  cachedTemplates.set(normalizedTemplateDir, template);
  return template;
}

function publicTemplateId(template: MockupTemplate, templateDir: string) {
  return (template.id || templateDir).replace(/-v\d+$/, "");
}

function normalizeTemplateDir(templateDir: string) {
  const normalized = path.normalize(templateDir).replace(/^(\.\.(\/|\\|$))+/, "");
  const fullPath = path.join(mockupTemplatesRoot, normalized);
  if (!fullPath.startsWith(mockupTemplatesRoot)) {
    throw new AppError(500, "MOCKUP_TEMPLATE_INVALID", "Mockup template path is invalid");
  }
  return normalized;
}

async function createPreparedSource(sourceBuffer: Buffer, template: MockupTemplate): Promise<PreparedSourceImage> {
  const resolvedSource = resolveSourceDimensions(template);
  const buffer = await sharp(sourceBuffer)
    .rotate()
    .resize({
      width: resolvedSource.width,
      height: resolvedSource.height,
      fit: resolvedSource.fit,
      position: "centre",
      kernel: resolveSourceResizeKernel(template),
    })
    .png()
    .toBuffer();
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    buffer,
    data,
    width: info.width,
    height: info.height,
  };
}

function resolveSourceDimensions(template: MockupTemplate) {
  const configuredWidth = firstFinite(sourceWidth, template.sourceWidth, Number.NaN);
  const configuredHeight = firstFinite(sourceHeight, template.sourceHeight, Number.NaN);
  if (configuredWidth > 0 && configuredHeight > 0) {
    return {
      width: clampSourceDimension(configuredWidth),
      height: clampSourceDimension(configuredHeight),
      fit: template.sourceFit === "fill" ? "fill" as const : "cover" as const,
    };
  }
  const value = firstFinite(sourceSize, template.sourceSize, mockupSourceSize);
  const size = clampSourceDimension(value);
  return {
    width: size,
    height: size,
    fit: "cover" as const,
  };
}

function clampSourceDimension(value: number) {
  return Math.max(256, Math.min(4096, Math.round(value)));
}

function resolveSourceResizeKernel(template: MockupTemplate): SourceResizeKernel {
  if (isSourceResizeKernel(sourceResizeKernel)) {
    return sourceResizeKernel;
  }
  return template.sourceResizeKernel ?? "lanczos3";
}

function isSourceResizeKernel(value: string): value is SourceResizeKernel {
  return value === "nearest"
    || value === "cubic"
    || value === "mitchell"
    || value === "lanczos2"
    || value === "lanczos3";
}

async function renderSceneBuffer(templateDir: string, scene: TemplateScene, sourceBuffer: PreparedSourceImage, options: RenderOptions) {
  let canvasBuffer = await sharp({
    create: {
      width: scene.width,
      height: scene.height,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();

  const layers = [...scene.layers].sort((a, b) => a.order - b.order);
  for (const layer of layers) {
    const renderedLayer = await renderSceneLayer(templateDir, layer, scene, sourceBuffer, options);
    if (!renderedLayer) {
      continue;
    }

    if (renderedLayer.blend === "linear_light") {
      canvasBuffer = await compositeLinearLight(
        canvasBuffer,
        renderedLayer.input,
        renderedLayer.left,
        renderedLayer.top,
        resolveLinearLightStrength(renderedLayer, scene, options),
      );
      continue;
    }

    if (isCustomBlendMode(renderedLayer.blend)) {
      canvasBuffer = await compositeCustomBlend(
        canvasBuffer,
        renderedLayer.input,
        renderedLayer.left,
        renderedLayer.top,
        renderedLayer.blend,
      );
      continue;
    }

    canvasBuffer = await sharp(canvasBuffer)
      .composite([{
        input: renderedLayer.input,
        left: renderedLayer.left,
        top: renderedLayer.top,
        blend: renderedLayer.blend,
      }])
      .png()
      .toBuffer();
  }

  canvasBuffer = await applySceneOutputOffset(canvasBuffer, scene);
  return canvasBuffer;
}

async function applySceneOutputOffset(canvasBuffer: Buffer, scene: TemplateScene) {
  const offsetX = Math.round(scene.outputOffsetX ?? 0);
  const offsetY = Math.round(scene.outputOffsetY ?? 0);
  if (!offsetX && !offsetY) {
    return canvasBuffer;
  }
  const { data, info } = await sharp(canvasBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.alloc(data.length, 255);
  for (let y = 0; y < info.height; y += 1) {
    const sourceY = y - offsetY;
    if (sourceY < 0 || sourceY >= info.height) {
      continue;
    }
    for (let x = 0; x < info.width; x += 1) {
      const sourceX = x - offsetX;
      if (sourceX < 0 || sourceX >= info.width) {
        continue;
      }
      const targetOffset = (y * info.width + x) * 4;
      const sourceOffset = (sourceY * info.width + sourceX) * 4;
      output[targetOffset] = data[sourceOffset];
      output[targetOffset + 1] = data[sourceOffset + 1];
      output[targetOffset + 2] = data[sourceOffset + 2];
      output[targetOffset + 3] = data[sourceOffset + 3];
    }
  }
  return sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

async function renderSceneLayer(templateDir: string, layer: TemplateLayer, scene: TemplateScene, sourceBuffer: PreparedSourceImage, options: RenderOptions): Promise<RenderedLayer | null> {
  const visibleArea = getVisibleArea(layer, scene);
  if (!visibleArea) {
    return null;
  }

  if (layer.kind === "replace") {
    if (layer.uvMapX && layer.uvMapY) {
      const replacementLayer = await applyLayerMask(
        templateDir,
        await renderUvMappedReplacementLayer(templateDir, sourceBuffer, layer, scene, options),
        layer,
        scene,
      );
      return {
        input: await applyReplacementPostProcessing(replacementLayer, layer),
        left: 0,
        top: 0,
        blend: mapBlendMode(layer.blendMode),
      };
    }
    if (layer.transform?.length === 8 && !isAxisAlignedTransform(layer.transform)) {
      const replacementLayer = await applyLayerMask(
        templateDir,
        await renderPerspectiveReplacementLayer(sourceBuffer, layer, scene, options),
        layer,
        scene,
      );
      return {
        input: await applyReplacementPostProcessing(replacementLayer, layer),
        left: 0,
        top: 0,
        blend: mapBlendMode(layer.blendMode),
      };
    }
    return {
      input: await applyLayerMask(templateDir, await renderReplacementLayer(sourceBuffer, layer, scene, visibleArea, options), layer, scene, visibleArea),
      left: visibleArea.left,
      top: visibleArea.top,
      blend: mapBlendMode(layer.blendMode),
    };
  }

  if (!layer.file) {
    return null;
  }

  const imageLayer = await readImageLayer(templateDir, layer.file);
  return {
      input: await cropLayerToVisibleArea(imageLayer, layer, visibleArea, layer.opacity),
      left: visibleArea.left,
      top: visibleArea.top,
      blend: mapBlendMode(layer.blendMode),
      blendStrength: layer.blendStrength,
    };
}

async function renderPerspectiveReplacementLayer(sourceBuffer: PreparedSourceImage, layer: TemplateLayer, scene: TemplateScene, options: RenderOptions) {
  if (!layer.transform || layer.transform.length !== 8) {
    return renderReplacementLayer(sourceBuffer, layer, scene, {
      left: Math.max(0, Math.round(layer.left)),
      top: Math.max(0, Math.round(layer.top)),
      width: Math.max(1, Math.round(layer.width)),
      height: Math.max(1, Math.round(layer.height)),
      cropLeft: 0,
      cropTop: 0,
    }, options);
  }
  const pixelOffset = resolvePerspectivePixelOffset(layer, scene, options);
  const sourceImage = await sourceImageForLayer(sourceBuffer, layer);
  const perspectiveInput = {
    sourceImage,
    sceneWidth: scene.width,
    sceneHeight: scene.height,
    sampleMode: options.perspectiveSampleMode || resolvePerspectiveSampleMode(perspectiveSampleMode) || layer.sampleMode || "edge",
    interpolation: options.perspectiveInterpolation || resolvePerspectiveInterpolation(perspectiveInterpolation) || layer.interpolation || "bilinear",
    pixelOffsetX: pixelOffset.x,
    pixelOffsetY: pixelOffset.y,
  };
  if (isValidPerspectiveMesh(layer.perspectiveMesh)) {
    return renderPerspectiveMeshImage({
      ...perspectiveInput,
      mesh: layer.perspectiveMesh,
    });
  }
  return renderPerspectiveImage({
    ...perspectiveInput,
    target: transformToPoints(layer.transform),
  });
}

async function sourceImageForLayer(sourceBuffer: PreparedSourceImage, layer: TemplateLayer): Promise<PreparedSourceImage> {
  if (!layer.sourceCrop) {
    return sourceBuffer;
  }
  const crop = normalizeSourceCrop(layer.sourceCrop, sourceBuffer);
  const buffer = await sharp(sourceBuffer.buffer)
    .extract(crop)
    .png()
    .toBuffer();
  const { data, info } = await sharp(buffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return {
    buffer,
    data,
    width: info.width,
    height: info.height,
  };
}

async function renderUvMappedReplacementLayer(
  templateDir: string,
  sourceBuffer: PreparedSourceImage,
  layer: TemplateLayer,
  scene: TemplateScene,
  options: RenderOptions,
) {
  if (!layer.uvMapX || !layer.uvMapY) {
    throw new AppError(500, "MOCKUP_UV_MAP_MISSING", "Mockup UV map files are missing");
  }
  const [xMapBuffer, yMapBuffer] = await Promise.all([
    readImageLayer(templateDir, layer.uvMapX),
    readImageLayer(templateDir, layer.uvMapY),
  ]);
  const [xMap, yMap] = await Promise.all([
    sharp(xMapBuffer)
      .resize(scene.width, scene.height, { fit: "fill", kernel: "nearest" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
    sharp(yMapBuffer)
      .resize(scene.width, scene.height, { fit: "fill", kernel: "nearest" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true }),
  ]);
  if (xMap.info.width !== yMap.info.width || xMap.info.height !== yMap.info.height) {
    throw new AppError(500, "MOCKUP_UV_MAP_SIZE_MISMATCH", "Mockup UV map sizes do not match");
  }

  const sourceImage = await sourceImageForLayer(sourceBuffer, layer);
  const output = Buffer.alloc(scene.width * scene.height * 4);
  const interpolation = options.perspectiveInterpolation
    || resolvePerspectiveInterpolation(perspectiveInterpolation)
    || layer.interpolation
    || "bilinear";
  const pixelOffset = resolvePerspectivePixelOffset(layer, scene, options);
  const encoding = layer.uvMapEncoding || "rg16";

  for (let pixel = 0, offset = 0; pixel < scene.width * scene.height; pixel += 1, offset += 4) {
    const alpha = Math.min(xMap.data[offset + 3], yMap.data[offset + 3]);
    if (alpha <= 0) {
      continue;
    }
    const sourceX = decodeUvCoordinate(xMap.data, offset, encoding, sourceImage.width);
    const sourceY = decodeUvCoordinate(yMap.data, offset, encoding, sourceImage.height);
    const [r, g, b, a] = sampleImage(
      sourceImage.data,
      sourceImage.width,
      sourceImage.height,
      sourceX,
      sourceY,
      interpolation,
      pixelOffset.x,
      pixelOffset.y,
    );
    output[offset] = r;
    output[offset + 1] = g;
    output[offset + 2] = b;
    output[offset + 3] = Math.round((a * alpha) / 255);
  }

  return sharp(output, {
    raw: {
      width: scene.width,
      height: scene.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

function decodeUvCoordinate(data: Buffer, offset: number, encoding: "rg16" | "r8", size: number) {
  if (encoding === "r8") {
    return (data[offset] / 255) * (size - 1);
  }
  const value = data[offset] * 256 + data[offset + 1];
  return (value / 65535) * (size - 1);
}

function resolvePerspectiveSampleMode(value: string): PerspectiveSampleMode | undefined {
  if (value === "edge" || value === "center") {
    return value;
  }
  return undefined;
}

function resolvePerspectiveInterpolation(value: string): PerspectiveInterpolation | undefined {
  if (
    value === "nearest"
    || value === "bilinear"
    || value === "bicubic"
    || value === "bicubic-ps"
    || value === "bicubic-soft"
    || value === "mitchell"
    || value === "lanczos2"
    || value === "lanczos3"
    || value === "supersample2"
    || value === "supersample3"
    || value === "supersample4"
    || value === "supersample5"
  ) {
    return value;
  }
  return undefined;
}

function resolvePerspectivePixelOffset(layer: TemplateLayer, scene: TemplateScene, options: RenderOptions) {
  return {
    x: firstFinite(
      options.perspectivePixelOffsetX,
      perspectivePixelOffsetX,
      layer.pixelOffsetX,
      scene.pixelOffsetX,
      defaultPerspectivePixelOffsetX,
    ),
    y: firstFinite(
      options.perspectivePixelOffsetY,
      perspectivePixelOffsetY,
      layer.pixelOffsetY,
      scene.pixelOffsetY,
      defaultPerspectivePixelOffsetY,
    ),
  };
}

function firstFinite(...values: Array<number | undefined>) {
  for (const value of values) {
    if (value !== undefined && Number.isFinite(value)) {
      return value;
    }
  }
  return 0;
}

function resolveLinearLightStrength(layer: RenderedLayer, scene: TemplateScene, options?: RenderOptions) {
  return firstFinite(
    options?.linearLightStrength,
    layer.blendStrength,
    scene.linearLightStrength,
    options?.templateLinearLightStrength,
    linearLightStrength,
    1,
  );
}

async function applyLayerMask(templateDir: string, layerBuffer: Buffer, layer: TemplateLayer, scene: TemplateScene, visibleArea?: VisibleArea) {
  if (!layer.mask) {
    return applyClipMask(templateDir, layerBuffer, layer, scene, visibleArea);
  }
  const maskBuffer = await readImageLayer(templateDir, layer.mask);
  if (hasPositionedMask(layer)) {
    const maskArea = getMaskVisibleArea(layer, scene, visibleArea);
    if (!maskArea) {
      return layerBuffer;
    }
    const resizedMask = await sharp(maskBuffer)
      .resize({
        width: Math.max(1, Math.round(layer.maskWidth ?? layer.width)),
        height: Math.max(1, Math.round(layer.maskHeight ?? layer.height)),
        fit: "fill",
      })
      .extract({
        left: maskArea.cropLeft,
        top: maskArea.cropTop,
        width: maskArea.width,
        height: maskArea.height,
      })
      .ensureAlpha()
      .extractChannel("red")
      .png()
      .toBuffer();
    const fullMask = await placeGreyscaleMaskOnCanvas(resizedMask, {
      width: visibleArea?.width ?? scene.width,
      height: visibleArea?.height ?? scene.height,
      left: maskArea.left,
      top: maskArea.top,
    });
    return applyClipMask(templateDir, await multiplyAlphaByMask(layerBuffer, fullMask), layer, scene, visibleArea);
  }
  if (!visibleArea) {
    const maskVisibleArea = getVisibleArea(layer, scene);
    if (!maskVisibleArea) {
      return layerBuffer;
    }
    const croppedMaskBuffer = await sharp(maskBuffer)
      .resize({
        width: Math.max(1, Math.round(layer.width)),
        height: Math.max(1, Math.round(layer.height)),
        fit: "fill",
      })
      .extract({
        left: maskVisibleArea.cropLeft,
        top: maskVisibleArea.cropTop,
        width: maskVisibleArea.width,
        height: maskVisibleArea.height,
      })
      .ensureAlpha()
      .extractChannel("red")
      .png()
      .toBuffer();
    const maskLayerBuffer = await placeGreyscaleMaskOnCanvas(croppedMaskBuffer, {
      width: scene.width,
      height: scene.height,
      left: maskVisibleArea.left,
      top: maskVisibleArea.top,
    });
    return applyClipMask(templateDir, await multiplyAlphaByMask(layerBuffer, maskLayerBuffer), layer, scene, visibleArea);
  }
  const fullMaskBuffer = await sharp(maskBuffer)
    .resize({
      width: Math.max(1, Math.round(layer.width)),
      height: Math.max(1, Math.round(layer.height)),
      fit: "fill",
    })
    .extract({
      left: visibleArea.cropLeft,
      top: visibleArea.cropTop,
      width: visibleArea.width,
      height: visibleArea.height,
    })
    .ensureAlpha()
    .extractChannel("red")
    .png()
    .toBuffer();
  return applyClipMask(templateDir, await multiplyAlphaByMask(layerBuffer, fullMaskBuffer), layer, scene, visibleArea);
}

function hasPositionedMask(layer: TemplateLayer) {
  return layer.maskLeft !== undefined
    || layer.maskTop !== undefined
    || layer.maskWidth !== undefined
    || layer.maskHeight !== undefined;
}

async function applyClipMask(templateDir: string, layerBuffer: Buffer, layer: TemplateLayer, scene: TemplateScene, visibleArea?: VisibleArea) {
  if (!layer.clipMask) {
    return layerBuffer;
  }
  const clipBuffer = await readImageLayer(templateDir, layer.clipMask);
  const clipArea = getClipMaskVisibleArea(layer, scene, visibleArea);
  if (!clipArea) {
    return layerBuffer;
  }
  const resizedClip = await sharp(clipBuffer)
    .resize({
      width: Math.max(1, Math.round(layer.clipMaskWidth ?? layer.width)),
      height: Math.max(1, Math.round(layer.clipMaskHeight ?? layer.height)),
      fit: "fill",
    })
    .extract({
      left: clipArea.cropLeft,
      top: clipArea.cropTop,
      width: clipArea.width,
      height: clipArea.height,
    })
    .ensureAlpha()
    .extractChannel("alpha")
    .png()
    .toBuffer();
  if (visibleArea) {
    const fullClip = await placeGreyscaleMaskOnCanvas(resizedClip, {
      width: visibleArea.width,
      height: visibleArea.height,
      left: clipArea.left,
      top: clipArea.top,
    });
    return multiplyAlphaByMask(layerBuffer, fullClip);
  }
  const fullClip = await placeGreyscaleMaskOnCanvas(resizedClip, {
    width: scene.width,
    height: scene.height,
    left: clipArea.left,
    top: clipArea.top,
  });
  return multiplyAlphaByMask(layerBuffer, fullClip);
}

async function placeGreyscaleMaskOnCanvas(maskBuffer: Buffer, input: {
  width: number;
  height: number;
  left: number;
  top: number;
}) {
  return sharp({
    create: {
      width: input.width,
      height: input.height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .composite([{ input: maskBuffer, left: input.left, top: input.top }])
    .greyscale()
    .png()
    .toBuffer();
}

async function multiplyAlphaByMask(layerBuffer: Buffer, maskBuffer: Buffer) {
  const [{ data, info }, { data: maskData, info: maskInfo }] = await Promise.all([
    sharp(layerBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(maskBuffer).greyscale().extractChannel(0).raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (info.width !== maskInfo.width || info.height !== maskInfo.height) {
    throw new AppError(500, "MOCKUP_MASK_SIZE_MISMATCH", "Mockup mask size does not match");
  }
  const output = Buffer.from(data);
  for (let pixel = 0, alphaOffset = 3; pixel < maskData.length; pixel += 1, alphaOffset += 4) {
    output[alphaOffset] = Math.round((output[alphaOffset] * maskData[pixel]) / 255);
  }
  return sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  }).png().toBuffer();
}

function isCustomBlendMode(value: LayerBlend): value is "multiply" | "screen" | "overlay" | "darken" | "lighten" {
  return value === "multiply"
    || value === "screen"
    || value === "overlay"
    || value === "darken"
    || value === "lighten";
}

async function compositeCustomBlend(baseBuffer: Buffer, layerBuffer: Buffer, left: number, top: number, blendMode: "multiply" | "screen" | "overlay" | "darken" | "lighten") {
  const [{ data: baseData, info: baseInfo }, { data: layerData, info: layerInfo }] = await Promise.all([
    sharp(baseBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(layerBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  const output = Buffer.from(baseData);
  const startX = Math.max(0, left);
  const startY = Math.max(0, top);
  const endX = Math.min(baseInfo.width, left + layerInfo.width);
  const endY = Math.min(baseInfo.height, top + layerInfo.height);

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const baseOffset = (y * baseInfo.width + x) * 4;
      const layerX = x - left;
      const layerY = y - top;
      const layerOffset = (layerY * layerInfo.width + layerX) * 4;
      const alpha = layerData[layerOffset + 3] / 255;
      if (alpha <= 0) {
        continue;
      }
      for (let channel = 0; channel < 3; channel += 1) {
        const blended = blendChannel(baseData[baseOffset + channel], layerData[layerOffset + channel], blendMode);
        output[baseOffset + channel] = clampByte(Math.round(blended * alpha + baseData[baseOffset + channel] * (1 - alpha)));
      }
      output[baseOffset + 3] = 255;
    }
  }

  return sharp(output, {
    raw: {
      width: baseInfo.width,
      height: baseInfo.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

function blendChannel(base: number, layer: number, blendMode: "multiply" | "screen" | "overlay" | "darken" | "lighten") {
  const d = Math.round(base);
  const s = Math.round(layer);
  if (blendMode === "multiply") return Math.round((d * s) / 255);
  if (blendMode === "screen") return 255 - Math.round(((255 - d) * (255 - s)) / 255);
  if (blendMode === "overlay") {
    return d < 128
      ? Math.round((2 * d * s) / 255)
      : 255 - Math.round((2 * (255 - d) * (255 - s)) / 255);
  }
  if (blendMode === "darken") return Math.min(d, s);
  return Math.max(d, s);
}
async function compositeLinearLight(baseBuffer: Buffer, layerBuffer: Buffer, left: number, top: number, strength = linearLightStrength) {
  const [{ data: baseData, info: baseInfo }, { data: layerData, info: layerInfo }] = await Promise.all([
    sharp(baseBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(layerBuffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);

  const output = Buffer.from(baseData);
  const startX = Math.max(0, left);
  const startY = Math.max(0, top);
  const endX = Math.min(baseInfo.width, left + layerInfo.width);
  const endY = Math.min(baseInfo.height, top + layerInfo.height);

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      const baseOffset = (y * baseInfo.width + x) * 4;
      const layerX = x - left;
      const layerY = y - top;
      const layerOffset = (layerY * layerInfo.width + layerX) * 4;
      const alpha = layerData[layerOffset + 3] / 255;
      if (alpha <= 0) {
        continue;
      }

      for (let channel = 0; channel < 3; channel += 1) {
        const blended = linearLightChannel(baseData[baseOffset + channel], layerData[layerOffset + channel], strength);
        output[baseOffset + channel] = clampByte(Math.round(blended * alpha + baseData[baseOffset + channel] * (1 - alpha)));
      }
      output[baseOffset + 3] = 255;
    }
  }

  return sharp(output, {
    raw: {
      width: baseInfo.width,
      height: baseInfo.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

function linearLightChannel(base: number, blend: number, strength: number) {
  return clampByte(base + (2 * blend - 255) * strength);
}

function clampByte(value: number) {
  return Math.max(0, Math.min(255, value));
}

function mapUnitToSourcePixel(uv: { u: number; v: number }, width: number, height: number, sampleMode: string) {
  return {
    x: mapCoordinateToSourcePixel(uv.u, width, sampleMode),
    y: mapCoordinateToSourcePixel(uv.v, height, sampleMode),
  };
}

function mapCoordinateToSourcePixel(value: number, size: number, sampleMode: string) {
  if (sampleMode === "center") {
    return Math.max(0, Math.min(size - 1, value * size - 0.5));
  }
  return Math.max(0, Math.min(size - 1, value * (size - 1)));
}

function readNumberEnv(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readSceneFilterEnv() {
  const raw = process.env.MOCKUP_SCENE_FILTER;
  if (!raw) {
    return null;
  }
  const indexes = raw
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value > 0);
  return indexes.length ? new Set(indexes) : null;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
) {
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      await worker(items[currentIndex], currentIndex);
    }
  }));
}

async function renderPerspectiveMeshImage(input: {
  sourceImage: PreparedSourceImage;
  sceneWidth: number;
  sceneHeight: number;
  mesh: PerspectiveMesh;
  sampleMode: string;
  interpolation: string;
  pixelOffsetX: number;
  pixelOffsetY: number;
}) {
  const output = Buffer.alloc(input.sceneWidth * input.sceneHeight * 4);
  for (const quad of input.mesh.quads) {
    if (quad.length !== 4) {
      continue;
    }
    const sourceTarget = quad.map((index) => input.mesh.vertices[index]);
    const warpedTarget = quad.map((index) => input.mesh.warpedVertices[index]);
    if (!isPointQuad(sourceTarget) || !isPointQuad(warpedTarget)) {
      continue;
    }
    renderPerspectiveQuadIntoBuffer({
      output,
      sourceImage: input.sourceImage,
      sceneWidth: input.sceneWidth,
      sceneHeight: input.sceneHeight,
      sourceTarget,
      warpedTarget,
      sampleMode: input.sampleMode,
      interpolation: input.interpolation,
      pixelOffsetX: input.pixelOffsetX,
      pixelOffsetY: input.pixelOffsetY,
    });
  }
  return sharp(output, {
    raw: {
      width: input.sceneWidth,
      height: input.sceneHeight,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

async function renderPerspectiveImage(input: {
  sourceImage: PreparedSourceImage;
  sceneWidth: number;
  sceneHeight: number;
  target: [Point, Point, Point, Point];
  sampleMode: string;
  interpolation: string;
  pixelOffsetX: number;
  pixelOffsetY: number;
}) {
  const output = Buffer.alloc(input.sceneWidth * input.sceneHeight * 4);
  renderPerspectiveQuadIntoBuffer({
    output,
    sourceImage: input.sourceImage,
    sceneWidth: input.sceneWidth,
    sceneHeight: input.sceneHeight,
    sourceTarget: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
    warpedTarget: input.target,
    sampleMode: input.sampleMode,
    interpolation: input.interpolation,
    pixelOffsetX: input.pixelOffsetX,
    pixelOffsetY: input.pixelOffsetY,
  });

  return sharp(output, {
    raw: {
      width: input.sceneWidth,
      height: input.sceneHeight,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

function renderPerspectiveQuadIntoBuffer(input: {
  output: Buffer;
  sourceImage: PreparedSourceImage;
  sceneWidth: number;
  sceneHeight: number;
  sourceTarget: [Point, Point, Point, Point];
  warpedTarget: [Point, Point, Point, Point];
  sampleMode: string;
  interpolation: string;
  pixelOffsetX: number;
  pixelOffsetY: number;
}) {
  const bounds = targetBounds(input.warpedTarget, input.sceneWidth, input.sceneHeight);
  const sourceHomography = homographyFromUnitSquare(input.sourceTarget);
  const warpedHomography = homographyFromUnitSquare(input.warpedTarget);
  const inverseWarpedHomography = invertHomography(warpedHomography);
  if (!inverseWarpedHomography) {
    return;
  }

  for (let y = bounds.top; y < bounds.bottom; y += 1) {
    for (let x = bounds.left; x < bounds.right; x += 1) {
      const uv = mapTargetToUnit(inverseWarpedHomography, x + 0.5, y + 0.5);
      if (!uv || uv.u < -0.001 || uv.u > 1.001 || uv.v < -0.001 || uv.v > 1.001) {
        continue;
      }
      const sourceUnit = mapUnitToTarget(sourceHomography, uv.u, uv.v);
      const sourceX = mapCoordinateToSourcePixel(sourceUnit.x, input.sourceImage.width, input.sampleMode);
      const sourceY = mapCoordinateToSourcePixel(sourceUnit.y, input.sourceImage.height, input.sampleMode);
      const [r, g, b, a] = sampleImage(
        input.sourceImage.data,
        input.sourceImage.width,
        input.sourceImage.height,
        sourceX,
        sourceY,
        input.interpolation,
        input.pixelOffsetX,
        input.pixelOffsetY,
      );
      const outputOffset = (y * input.sceneWidth + x) * 4;
      input.output[outputOffset] = r;
      input.output[outputOffset + 1] = g;
      input.output[outputOffset + 2] = b;
      input.output[outputOffset + 3] = a;
    }
  }
}

async function renderReplacementLayer(
  sourceBuffer: PreparedSourceImage,
  layer: TemplateLayer,
  scene: TemplateScene,
  visibleArea: VisibleArea,
  options?: RenderOptions,
) {
  const resolvedReplacementResizeKernel = resolveReplacementResizeKernel(layer, scene, options);
  const sourcePipeline = layer.sourceCrop
    ? sharp(sourceBuffer.buffer).extract(normalizeSourceCrop(layer.sourceCrop, sourceBuffer))
    : sharp(sourceBuffer.buffer);
  const resized = sourcePipeline
    .resize({
      width: Math.max(1, Math.round(layer.width)),
      height: Math.max(1, Math.round(layer.height)),
      fit: "cover",
      position: "centre",
      ...(resolvedReplacementResizeKernel ? { kernel: resolvedReplacementResizeKernel } : {}),
    });
  return extractVisibleLayer(resized, visibleArea, layer.opacity);
}

function normalizeSourceCrop(crop: SourceCrop, sourceBuffer: PreparedSourceImage) {
  const left = Math.max(0, Math.min(sourceBuffer.width - 1, Math.round(crop.left)));
  const top = Math.max(0, Math.min(sourceBuffer.height - 1, Math.round(crop.top)));
  const right = Math.max(left + 1, Math.min(sourceBuffer.width, Math.round(crop.left + crop.width)));
  const bottom = Math.max(top + 1, Math.min(sourceBuffer.height, Math.round(crop.top + crop.height)));
  return {
    left,
    top,
    width: right - left,
    height: bottom - top,
  };
}

function resolveReplacementResizeKernel(
  layer: TemplateLayer,
  scene: TemplateScene,
  options?: RenderOptions,
): SourceResizeKernel | undefined {
  if (options?.replacementResizeKernel) {
    return options.replacementResizeKernel;
  }
  if (isSourceResizeKernel(replacementResizeKernel)) {
    return replacementResizeKernel;
  }
  return layer.replacementResizeKernel
    ?? scene.replacementResizeKernel;
}

async function cropLayerToVisibleArea(
  layerBuffer: Buffer,
  layer: TemplateLayer,
  visibleArea: VisibleArea,
  opacity = 1,
) {
  const image = sharp(layerBuffer).resize({
    width: Math.max(1, Math.round(layer.width)),
    height: Math.max(1, Math.round(layer.height)),
    fit: "fill",
  });
  return extractVisibleLayer(image, visibleArea, opacity);
}

async function extractVisibleLayer(image: sharp.Sharp, visibleArea: VisibleArea, opacity = 1) {
  let pipeline = image.extract({
    left: visibleArea.cropLeft,
    top: visibleArea.cropTop,
    width: visibleArea.width,
    height: visibleArea.height,
  });
  const normalizedOpacity = Math.min(1, Math.max(0, opacity));
  if (normalizedOpacity < 1) {
    return multiplyLayerOpacity(await pipeline.png().toBuffer(), normalizedOpacity);
  }
  return pipeline.png().toBuffer();
}

async function multiplyLayerOpacity(layerBuffer: Buffer, opacity: number) {
  const { data, info } = await sharp(layerBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  for (let alphaOffset = 3; alphaOffset < output.length; alphaOffset += 4) {
    output[alphaOffset] = Math.round(output[alphaOffset] * opacity);
  }
  return sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

async function applyReplacementPostProcessing(layerBuffer: Buffer, layer: TemplateLayer) {
  let output = layerBuffer;
  if (layer.colorCorrection) {
    output = await applyLayerColorCorrection(output, layer.colorCorrection);
  }
  if (Number.isFinite(layer.edgeFeather) && (layer.edgeFeather ?? 0) > 0) {
    output = await featherLayerAlpha(output, layer.edgeFeather ?? 0);
  }
  return applyReplacementOpacity(output, layer.opacity);
}

async function applyLayerColorCorrection(layerBuffer: Buffer, correction: LayerColorCorrection) {
  const { data, info } = await sharp(layerBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const output = Buffer.from(data);
  const strength = Math.min(1, Math.max(0, correction.strength ?? 1));
  const channels = [correction.red, correction.green, correction.blue];
  for (let offset = 0; offset < output.length; offset += 4) {
    if (output[offset + 3] <= 0) {
      continue;
    }
    for (let channel = 0; channel < 3; channel += 1) {
      const channelCorrection = channels[channel];
      if (!channelCorrection) {
        continue;
      }
      const current = output[offset + channel];
      const corrected = clampByte((channelCorrection.scale ?? 1) * current + (channelCorrection.offset ?? 0));
      output[offset + channel] = clampByte(current * (1 - strength) + corrected * strength);
    }
  }
  return sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

async function applyReplacementOpacity(layerBuffer: Buffer, opacity = 1) {
  const normalizedOpacity = Math.min(1, Math.max(0, opacity));
  if (normalizedOpacity >= 1) {
    return layerBuffer;
  }
  return multiplyLayerOpacity(layerBuffer, normalizedOpacity);
}

async function featherLayerAlpha(layerBuffer: Buffer, radius: number) {
  const normalizedRadius = Math.min(10, Math.max(0.3, radius));
  const { data, info } = await sharp(layerBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const blurredAlpha = await sharp(data, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .extractChannel("alpha")
    .blur(normalizedRadius)
    .raw()
    .toBuffer();
  const output = Buffer.from(data);
  for (let pixel = 0, alphaOffset = 3; pixel < blurredAlpha.length; pixel += 1, alphaOffset += 4) {
    output[alphaOffset] = blurredAlpha[pixel];
  }
  return sharp(output, {
    raw: {
      width: info.width,
      height: info.height,
      channels: 4,
    },
  })
    .png()
    .toBuffer();
}

type Point = {
  x: number;
  y: number;
};

function transformToPoints(values: number[]): [Point, Point, Point, Point] {
  return [
    { x: values[0], y: values[1] },
    { x: values[2], y: values[3] },
    { x: values[4], y: values[5] },
    { x: values[6], y: values[7] },
  ];
}

function isValidPerspectiveMesh(value: PerspectiveMesh | undefined): value is PerspectiveMesh {
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

type Homography = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  g: number;
  h: number;
};

type InverseHomography = {
  m00: number;
  m01: number;
  m02: number;
  m10: number;
  m11: number;
  m12: number;
  m20: number;
  m21: number;
  m22: number;
};

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

function mapTargetToUnit(inverse: InverseHomography, x: number, y: number): { u: number; v: number } | null {
  const denominator = inverse.m20 * x + inverse.m21 * y + inverse.m22;
  if (Math.abs(denominator) < 0.000001) {
    return null;
  }
  const u = (inverse.m00 * x + inverse.m01 * y + inverse.m02) / denominator;
  const v = (inverse.m10 * x + inverse.m11 * y + inverse.m12) / denominator;
  return { u, v };
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

function invertHomography(homography: Homography): InverseHomography | null {
  const { a, b, c, d, e, f, g, h } = homography;
  const determinant =
    a * (e - f * h)
    - b * (d - f * g)
    + c * (d * h - e * g);
  if (Math.abs(determinant) < 0.000001) {
    return null;
  }
  return {
    m00: (e - f * h) / determinant,
    m01: (c * h - b) / determinant,
    m02: (b * f - c * e) / determinant,
    m10: (f * g - d) / determinant,
    m11: (a - c * g) / determinant,
    m12: (c * d - a * f) / determinant,
    m20: (d * h - e * g) / determinant,
    m21: (b * g - a * h) / determinant,
    m22: (a * e - b * d) / determinant,
  };
}

function sampleBilinear(data: Buffer, width: number, height: number, x: number, y: number): [number, number, number, number] {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const tx = x - x0;
  const ty = y - y0;
  const topLeft = readPixel(data, width, x0, y0);
  const topRight = readPixel(data, width, x1, y0);
  const bottomLeft = readPixel(data, width, x0, y1);
  const bottomRight = readPixel(data, width, x1, y1);
  return [0, 1, 2, 3].map((channel) => {
    const top = topLeft[channel] * (1 - tx) + topRight[channel] * tx;
    const bottom = bottomLeft[channel] * (1 - tx) + bottomRight[channel] * tx;
    return clampByte(Math.round(top * (1 - ty) + bottom * ty));
  }) as [number, number, number, number];
}

function sampleImage(
  data: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  interpolation: string,
  pixelOffsetX: number,
  pixelOffsetY: number,
): [number, number, number, number] {
  x = Math.max(0, Math.min(width - 1, x + pixelOffsetX));
  y = Math.max(0, Math.min(height - 1, y + pixelOffsetY));
  if (interpolation === "nearest") {
    return readPixel(data, width, Math.round(x), Math.round(y));
  }
  if (interpolation === "supersample2") {
    return sampleSupersampled(data, width, height, x, y, 2);
  }
  if (interpolation === "supersample3") {
    return sampleSupersampled(data, width, height, x, y, 3);
  }
  if (interpolation === "supersample4") {
    return sampleSupersampled(data, width, height, x, y, 4);
  }
  if (interpolation === "supersample5") {
    return sampleSupersampled(data, width, height, x, y, 5);
  }
  if (interpolation === "bicubic") {
    return sampleBicubic(data, width, height, x, y);
  }
  if (interpolation === "bicubic-ps") {
    return sampleCubic(data, width, height, x, y, -0.75);
  }
  if (interpolation === "bicubic-soft") {
    return sampleCubic(data, width, height, x, y, -0.25);
  }
  if (interpolation === "mitchell") {
    return sampleSeparable(data, width, height, x, y, 2, mitchellWeight);
  }
  if (interpolation === "lanczos2") {
    return sampleSeparable(data, width, height, x, y, 2, (value) => lanczosWeight(value, 2));
  }
  if (interpolation === "lanczos3") {
    return sampleSeparable(data, width, height, x, y, 3, (value) => lanczosWeight(value, 3));
  }
  return sampleBilinear(data, width, height, x, y);
}

function sampleSupersampled(
  data: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  gridSize: number,
): [number, number, number, number] {
  const output = [0, 0, 0, 0];
  const step = 1 / gridSize;
  const start = (step - 1) / 2;
  let count = 0;
  for (let sampleY = 0; sampleY < gridSize; sampleY += 1) {
    for (let sampleX = 0; sampleX < gridSize; sampleX += 1) {
      const pixel = sampleBilinear(
        data,
        width,
        height,
        x + start + sampleX * step,
        y + start + sampleY * step,
      );
      for (let channel = 0; channel < 4; channel += 1) {
        output[channel] += pixel[channel];
      }
      count += 1;
    }
  }
  return output.map((value) => clampByte(Math.round(value / count))) as [number, number, number, number];
}

function sampleBicubic(data: Buffer, width: number, height: number, x: number, y: number): [number, number, number, number] {
  const baseX = Math.floor(x);
  const baseY = Math.floor(y);
  const tx = x - baseX;
  const ty = y - baseY;
  const output = [0, 0, 0, 0];

  for (let m = -1; m <= 2; m += 1) {
    const weightY = cubicWeight(m - ty);
    const sampleY = Math.max(0, Math.min(height - 1, baseY + m));
    for (let n = -1; n <= 2; n += 1) {
      const weight = cubicWeight(n - tx) * weightY;
      const sampleX = Math.max(0, Math.min(width - 1, baseX + n));
      const pixel = readPixel(data, width, sampleX, sampleY);
      for (let channel = 0; channel < 4; channel += 1) {
        output[channel] += pixel[channel] * weight;
      }
    }
  }

  return output.map((value) => clampByte(Math.round(value))) as [number, number, number, number];
}

function cubicWeight(value: number) {
  const a = -0.5;
  const x = Math.abs(value);
  if (x <= 1) {
    return (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1;
  }
  if (x < 2) {
    return a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a;
  }
  return 0;
}

function sampleCubic(data: Buffer, width: number, height: number, x: number, y: number, a: number): [number, number, number, number] {
  return sampleSeparable(data, width, height, x, y, 2, (value) => cubicWeightWithA(value, a));
}

function cubicWeightWithA(value: number, a: number) {
  const x = Math.abs(value);
  if (x <= 1) {
    return (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1;
  }
  if (x < 2) {
    return a * x ** 3 - 5 * a * x ** 2 + 8 * a * x - 4 * a;
  }
  return 0;
}

function mitchellWeight(value: number) {
  const x = Math.abs(value);
  const b = 1 / 3;
  const c = 1 / 3;
  if (x < 1) {
    return ((12 - 9 * b - 6 * c) * x ** 3 + (-18 + 12 * b + 6 * c) * x ** 2 + (6 - 2 * b)) / 6;
  }
  if (x < 2) {
    return ((-b - 6 * c) * x ** 3 + (6 * b + 30 * c) * x ** 2 + (-12 * b - 48 * c) * x + (8 * b + 24 * c)) / 6;
  }
  return 0;
}

function lanczosWeight(value: number, radius: number) {
  const x = Math.abs(value);
  if (x < 0.000001) {
    return 1;
  }
  if (x >= radius) {
    return 0;
  }
  return sinc(x) * sinc(x / radius);
}

function sinc(value: number) {
  const x = Math.PI * value;
  return Math.sin(x) / x;
}

function sampleSeparable(
  data: Buffer,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
  weightFn: (value: number) => number,
): [number, number, number, number] {
  const baseX = Math.floor(x);
  const baseY = Math.floor(y);
  const output = [0, 0, 0, 0];
  let weightTotal = 0;

  for (let sampleY = baseY - radius + 1; sampleY <= baseY + radius; sampleY += 1) {
    const weightY = weightFn(y - sampleY);
    if (weightY === 0) {
      continue;
    }
    const clampedY = Math.max(0, Math.min(height - 1, sampleY));
    for (let sampleX = baseX - radius + 1; sampleX <= baseX + radius; sampleX += 1) {
      const weight = weightFn(x - sampleX) * weightY;
      if (weight === 0) {
        continue;
      }
      const clampedX = Math.max(0, Math.min(width - 1, sampleX));
      const pixel = readPixel(data, width, clampedX, clampedY);
      for (let channel = 0; channel < 4; channel += 1) {
        output[channel] += pixel[channel] * weight;
      }
      weightTotal += weight;
    }
  }

  if (Math.abs(weightTotal) < 0.000001) {
    return sampleBilinear(data, width, height, x, y);
  }

  return output.map((value) => clampByte(Math.round(value / weightTotal))) as [number, number, number, number];
}

function readPixel(data: Buffer, width: number, x: number, y: number): [number, number, number, number] {
  const offset = (y * width + x) * 4;
  return [data[offset], data[offset + 1], data[offset + 2], data[offset + 3]];
}

async function outputBuffer(image: sharp.Sharp, template: MockupTemplate) {
  if (template.outputFormat === "png") {
    return image.png({ compressionLevel: 8 }).toBuffer();
  }
  if (template.outputFormat === "webp") {
    return image.webp({ quality: template.outputQuality || 88, effort: 4 }).toBuffer();
  }
  return image.jpeg({
    quality: template.outputQuality || 92,
    mozjpeg: outputMozjpeg ? outputMozjpeg === "true" : template.outputMozjpeg ?? true,
    chromaSubsampling: resolveOutputChromaSubsampling(template),
  }).toBuffer();
}

function resolveOutputChromaSubsampling(template: MockupTemplate): "4:2:0" | "4:4:4" {
  if (outputChromaSubsampling === "4:2:0" || outputChromaSubsampling === "4:4:4") {
    return outputChromaSubsampling;
  }
  return template.outputChromaSubsampling ?? "4:2:0";
}

function contentTypeForTemplate(template: MockupTemplate) {
  if (template.outputFormat === "png") return "image/png";
  if (template.outputFormat === "webp") return "image/webp";
  return "image/jpeg";
}

function extensionForTemplate(template: MockupTemplate) {
  if (template.outputFormat === "png") return "png";
  if (template.outputFormat === "webp") return "webp";
  return "jpg";
}

async function readImageLayer(templateDir: string, file: string) {
  const normalizedTemplateDir = normalizeTemplateDir(templateDir);
  const cacheKey = `${normalizedTemplateDir}/${file}`;
  const cached = cachedImageLayers.get(cacheKey);
  if (cached) {
    return cached;
  }
  const normalized = path.normalize(file);
  const templateRoot = path.join(mockupTemplatesRoot, normalizedTemplateDir);
  const fullPath = path.join(templateRoot, normalized);
  if (!fullPath.startsWith(templateRoot)) {
    throw new AppError(500, "MOCKUP_TEMPLATE_INVALID", "Mockup template path is invalid");
  }
  const buffer = await fs.readFile(fullPath);
  cachedImageLayers.set(cacheKey, buffer);
  return buffer;
}

type VisibleArea = {
  left: number;
  top: number;
  width: number;
  height: number;
  cropLeft: number;
  cropTop: number;
};

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
  if (width <= 0 || height <= 0) {
    return null;
  }
  return {
    left,
    top,
    width,
    height,
    cropLeft: left - layerLeft,
    cropTop: top - layerTop,
  };
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
  if (width <= 0 || height <= 0) {
    return null;
  }
  return {
    left: visibleArea ? left - outputLeft : left,
    top: visibleArea ? top - outputTop : top,
    width,
    height,
    cropLeft: left - maskLeft,
    cropTop: top - maskTop,
  };
}

function mapBlendMode(value?: string): LayerBlend {
  if (!value || value === "normal") return "over";
  const blendMap: Record<string, LayerBlend> = {
    multiply: "multiply",
    screen: "screen",
    overlay: "overlay",
    darken: "darken",
    lighten: "lighten",
    color_dodge: "color-dodge",
    colour_dodge: "colour-dodge",
    color_burn: "color-burn",
    colour_burn: "colour-burn",
    hard_light: "hard-light",
    soft_light: "soft-light",
    difference: "difference",
    exclusion: "exclusion",
    linear_light: "linear_light",
  };
  return blendMap[value] ?? "over";
}

