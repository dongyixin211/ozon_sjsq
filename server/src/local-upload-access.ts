import { pool } from "./db.js";

export type LocalUploadAccessSource = "static_uploads" | "storage_fallback";

export function objectKeyFromUploadsRequestUrl(url: string) {
  const pathname = url.split(/[?#]/, 1)[0] ?? "";
  if (!pathname.startsWith("/uploads/")) {
    return null;
  }
  const encodedObjectKey = pathname.slice("/uploads/".length);
  if (!encodedObjectKey) {
    return null;
  }
  let decodedObjectKey: string;
  try {
    decodedObjectKey = decodeURIComponent(encodedObjectKey);
  } catch {
    return null;
  }
  return normalizeLocalUploadObjectKey(decodedObjectKey);
}

export function normalizeLocalUploadObjectKey(value: string) {
  const normalized = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((part) => part && part !== ".")
    .join("/");
  if (!normalized || normalized.includes("\0")) {
    return null;
  }
  if (normalized.startsWith("/") || normalized.split("/").some((part) => part === "..")) {
    return null;
  }
  return normalized;
}

export async function recordLocalUploadAccess(input: {
  objectKey: string;
  source: LocalUploadAccessSource;
  error?: unknown;
}) {
  const objectKey = normalizeLocalUploadObjectKey(input.objectKey);
  if (!objectKey) {
    return;
  }
  const lastError = input.error ? errorText(input.error).slice(0, 1000) : null;
  try {
    await pool.query(
      `
      INSERT INTO local_upload_access_log (
        object_key,
        last_source,
        last_error
      )
      VALUES ($1, $2, $3)
      ON CONFLICT (object_key)
      DO UPDATE SET
        last_accessed_at = now(),
        access_count = local_upload_access_log.access_count + 1,
        last_source = EXCLUDED.last_source,
        last_error = EXCLUDED.last_error,
        updated_at = now()
      `,
      [objectKey, input.source, lastError],
    );
  } catch (error) {
    console.warn({ objectKey, source: input.source, error }, "record local upload access failed");
  }
}

function errorText(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
