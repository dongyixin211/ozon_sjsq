import path from "node:path";
import fs from "node:fs/promises";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import sharp from "sharp";
import { config } from "./config.js";
import { recordLocalUploadAccess } from "./local-upload-access.js";
import { sha256Hex } from "./security.js";

export type RatioFamily = "portrait" | "square" | "landscape" | "wide";

export interface PreparedImage {
  buffer: Buffer;
  sha256: string;
  width: number;
  height: number;
  ratio: number;
  ratioFamily: RatioFamily;
  objectKey: string;
  publicUrl: string;
  thumbBuffer: Buffer;
  thumbObjectKey: string;
  thumbUrl: string;
  contentType: string;
  sizeBytes: number;
  sku: string;
  sourceFilename: string;
}

export interface ObjectMetadata {
  contentType: string;
  sizeBytes: number;
}

export const thumbnailContentType = "image/webp";
export const compressedMockupContentType = "image/jpeg";

const compressedMockupQuality = 50;

const storageProvider = config.STORAGE_PROVIDER.toLowerCase();
const forcePathStyle = resolveForcePathStyle();
const localBackfillConcurrency = 2;
const localBackfillMaxQueue = 1000;
const localBackfillQueue: string[] = [];
const localBackfillKeys = new Set<string>();
let localBackfillActive = 0;
const s3 = storageProvider === "local"
  ? null
  : new S3Client({
      endpoint: config.STORAGE_ENDPOINT,
      region: config.STORAGE_REGION,
      credentials: {
        accessKeyId: config.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: config.STORAGE_SECRET_ACCESS_KEY,
      },
      forcePathStyle,
    });

export async function prepareImage(input: {
  buffer: Buffer;
  filename: string;
  mimetype: string;
  sku?: string;
}): Promise<PreparedImage> {
  const maxBytes = config.MAX_UPLOAD_MB * 1024 * 1024;
  if (input.buffer.length > maxBytes) {
    throw new Error(`图片文件过大，请上传不超过 ${config.MAX_UPLOAD_MB} MB 的图片`);
  }
  const metadata = await sharp(input.buffer).metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("无法读取图片宽高，请确认文件是有效图片");
  }

  const sku = normalizeSku(input.sku || path.parse(input.filename).name);
  const sha256 = sha256Hex(input.buffer);
  const ext = extensionFromMime(input.mimetype) || extensionFromFilename(input.filename) || "jpg";
  const ratio = metadata.width / metadata.height;
  const ratioFamily = classifyRatio(ratio);
  const objectKey = `gallery/${ratioFamily}/${sku}/${sha256.slice(0, 16)}.${ext}`;
  const thumbObjectKey = thumbnailObjectKeyForOriginal(objectKey);
  const thumbBuffer = await createThumbnailBuffer(input.buffer);

  return {
    buffer: input.buffer,
    sha256,
    width: metadata.width,
    height: metadata.height,
    ratio,
    ratioFamily,
    objectKey,
    publicUrl: publicUrlForObjectKey(objectKey),
    thumbBuffer,
    thumbObjectKey,
    thumbUrl: publicUrlForObjectKey(thumbObjectKey),
    contentType: input.mimetype || "application/octet-stream",
    sizeBytes: input.buffer.length,
    sku,
    sourceFilename: input.filename,
  };
}

export async function uploadPreparedImage(image: PreparedImage) {
  await uploadObject(image.objectKey, image.buffer, image.contentType);
  await uploadObject(image.thumbObjectKey, image.thumbBuffer, thumbnailContentType);
}

export async function createThumbnailBuffer(buffer: Buffer) {
  return sharp(buffer)
    .rotate()
    .resize({
      width: 360,
      height: 360,
      fit: "inside",
      withoutEnlargement: true,
    })
    .webp({
      quality: 74,
      effort: 4,
    })
    .toBuffer();
}

export async function createCompressedMockupBuffer(buffer: Buffer) {
  return sharp(buffer)
    .rotate()
    .jpeg({
      quality: compressedMockupQuality,
      mozjpeg: true,
      progressive: false,
    })
    .toBuffer();
}

export async function uploadObject(objectKey: string, buffer: Buffer, contentType: string) {
  if (storageProvider === "local") {
    const localPath = path.join(config.STORAGE_LOCAL_DIR, objectKey);
    await fs.mkdir(path.dirname(localPath), { recursive: true });
    await fs.writeFile(localPath, buffer);
    return;
  }
  if (!s3) {
    throw new Error("Storage client is not initialized");
  }
  await s3.send(new PutObjectCommand({
    Bucket: config.STORAGE_BUCKET,
    Key: objectKey,
    Body: buffer,
    ContentType: contentType,
    CacheControl: "public, max-age=31536000, immutable",
  }));
}

export async function createDirectUploadUrl(objectKey: string, contentType: string) {
  if (!s3 || storageProvider === "local") {
    throw new Error("当前存储配置不支持客户端直传");
  }
  const expiresIn = 15 * 60;
  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: config.STORAGE_BUCKET,
      Key: objectKey,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
    { expiresIn },
  );
  return { uploadUrl, expiresIn };
}

export async function objectExists(objectKey: string): Promise<boolean> {
  if (storageProvider === "local") {
    const localPath = path.join(config.STORAGE_LOCAL_DIR, objectKey);
    try {
      await fs.access(localPath);
      return true;
    } catch {
      return false;
    }
  }
  if (!s3) {
    throw new Error("Storage client is not initialized");
  }
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: config.STORAGE_BUCKET,
      Key: objectKey,
    }));
    return true;
  } catch {
    return false;
  }
}

export async function readObjectMetadata(objectKey: string): Promise<ObjectMetadata | null> {
  if (storageProvider === "local") {
    const localPath = path.join(config.STORAGE_LOCAL_DIR, objectKey);
    try {
      const stats = await fs.stat(localPath);
      return { contentType: contentTypeForObjectKey(objectKey), sizeBytes: stats.size };
    } catch {
      return null;
    }
  }
  if (!s3) {
    throw new Error("Storage client is not initialized");
  }
  try {
    const response = await s3.send(new HeadObjectCommand({
      Bucket: config.STORAGE_BUCKET,
      Key: objectKey,
    }));
    if (response.ContentLength === undefined || !response.ContentType) {
      return null;
    }
    return { contentType: response.ContentType, sizeBytes: response.ContentLength };
  } catch {
    return null;
  }
}

export async function readObjectBuffer(objectKey: string): Promise<Buffer> {
  if (storageProvider === "local") {
    const localPath = path.join(config.STORAGE_LOCAL_DIR, objectKey);
    return fs.readFile(localPath);
  }
  if (!s3) {
    throw new Error("Storage client is not initialized");
  }
  let response;
  try {
    response = await s3.send(new GetObjectCommand({
      Bucket: config.STORAGE_BUCKET,
      Key: objectKey,
    }));
  } catch (error) {
    const localBuffer = await readLocalObjectIfPresent(objectKey);
    if (localBuffer) {
      void recordLocalUploadAccess({
        objectKey,
        source: "storage_fallback",
        error,
      });
      scheduleLocalObjectBackfill(objectKey);
      return localBuffer;
    }
    throw error;
  }
  if (!response.Body) {
    throw new Error("图片文件读取失败");
  }
  return Buffer.from(await response.Body.transformToByteArray());
}

export function thumbnailObjectKeyForOriginal(objectKey: string) {
  const parsed = path.posix.parse(objectKey);
  const relativeDir = parsed.dir.replace(/^gallery\/?/, "");
  const prefix = relativeDir ? `gallery-thumbs/${relativeDir}` : "gallery-thumbs";
  return `${prefix}/${parsed.name}.webp`;
}

export function publicUrlForObjectKey(objectKey: string) {
  return `${config.STORAGE_PUBLIC_BASE_URL.replace(/\/$/, "")}/${encodeObjectKey(objectKey)}`;
}

function normalizeSku(value: string): string {
  const sku = value.trim().replace(/\s+/g, "-").replace(/[\\/:*?"<>|#%{}]/g, "-");
  if (!sku) {
    throw new Error("图片货号不能为空");
  }
  return sku.slice(0, 120);
}

function classifyRatio(ratio: number): RatioFamily {
  if (ratio >= 1.6) return "wide";
  if (ratio > 1.1) return "landscape";
  if (ratio >= 0.9) return "square";
  return "portrait";
}

function extensionFromMime(mime: string): string | null {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  if (mime === "image/jpeg") return "jpg";
  return null;
}

function extensionFromFilename(filename: string): string | null {
  const ext = path.extname(filename).replace(".", "").toLowerCase();
  return ext || null;
}

function encodeObjectKey(objectKey: string): string {
  return objectKey
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

async function readLocalObjectIfPresent(objectKey: string) {
  const localPath = path.join(config.STORAGE_LOCAL_DIR, objectKey);
  try {
    return await fs.readFile(localPath);
  } catch {
    return null;
  }
}

function scheduleLocalObjectBackfill(objectKey: string) {
  if (!s3 || storageProvider === "local" || localBackfillKeys.has(objectKey)) {
    return;
  }
  if (localBackfillQueue.length >= localBackfillMaxQueue) {
    return;
  }
  localBackfillKeys.add(objectKey);
  localBackfillQueue.push(objectKey);
  void drainLocalBackfillQueue();
}

async function drainLocalBackfillQueue() {
  while (localBackfillActive < localBackfillConcurrency && localBackfillQueue.length > 0) {
    const objectKey = localBackfillQueue.shift();
    if (!objectKey) {
      continue;
    }
    localBackfillActive += 1;
    void backfillLocalObject(objectKey)
      .catch((error) => {
        console.warn({ objectKey, error }, "backfill local object to storage failed");
      })
      .finally(() => {
        localBackfillActive -= 1;
        localBackfillKeys.delete(objectKey);
        void drainLocalBackfillQueue();
      });
  }
}

async function backfillLocalObject(objectKey: string) {
  if (!s3) {
    return;
  }
  const localBuffer = await readLocalObjectIfPresent(objectKey);
  if (!localBuffer) {
    return;
  }
  await s3.send(new PutObjectCommand({
    Bucket: config.STORAGE_BUCKET,
    Key: objectKey,
    Body: localBuffer,
    ContentType: contentTypeForObjectKey(objectKey),
    CacheControl: "public, max-age=31536000, immutable",
  }));
}

function contentTypeForObjectKey(objectKey: string) {
  const ext = path.extname(objectKey).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "application/octet-stream";
}

function resolveForcePathStyle() {
  const explicit = config.STORAGE_FORCE_PATH_STYLE.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(explicit)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(explicit)) {
    return false;
  }
  const endpoint = config.STORAGE_ENDPOINT.toLowerCase();
  if (storageProvider === "oss" || endpoint.includes(".aliyuncs.com")) {
    return false;
  }
  return true;
}
