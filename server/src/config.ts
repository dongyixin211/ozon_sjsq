import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  PUBLIC_API_BASE_URL: z.string().url().default("http://127.0.0.1:8787"),
  CORS_ORIGINS: z.string().optional().default(""),
  ADMIN_IP_ALLOWLIST: z.string().optional().default(""),
  JWT_SECRET: z.string().min(24, "JWT_SECRET must be at least 24 characters"),
  ADMIN_TOKEN: z.string().min(12, "ADMIN_TOKEN must be at least 12 characters"),
  DATABASE_URL: z.string().min(1),
  DB_POOL_MAX: z.coerce.number().int().positive().max(100).default(20),
  STORAGE_PROVIDER: z.string().default("r2"),
  STORAGE_ENDPOINT: z.string().optional().default(""),
  STORAGE_REGION: z.string().default("auto"),
  STORAGE_ACCESS_KEY_ID: z.string().optional().default(""),
  STORAGE_SECRET_ACCESS_KEY: z.string().optional().default(""),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_PUBLIC_BASE_URL: z.string().url(),
  STORAGE_LOCAL_DIR: z.string().optional().default("./uploads"),
  STORAGE_FORCE_PATH_STYLE: z.string().optional().default(""),
  MOCKUP_TEMPLATE_ROOT: z.string().optional().default(""),
  MAX_UPLOAD_MB: z.coerce.number().int().positive().default(15),
  MAX_PSD_UPLOAD_MB: z.coerce.number().int().positive().default(600),
  LEGACY_UPLOAD_ENABLED: z.coerce.boolean().default(true),
  LEGACY_UPLOAD_MAX_FILES: z.coerce.number().int().positive().max(50).default(20),
  LEGACY_UPLOAD_MAX_BYTES_MB: z.coerce.number().int().positive().max(128).default(48),
  CLOUD_MOCKUP_RENDER_ENABLED: z.coerce.boolean().default(false),
  CLOUD_MOCKUP_REQUEST_CONCURRENCY: z.coerce.number().int().positive().max(4).default(1),
  TITLE_GENERATION_GLOBAL_CONCURRENCY: z.coerce.number().int().positive().max(4).default(2),
  TITLE_GENERATION_USER_CONCURRENCY: z.coerce.number().int().positive().max(2).default(1),
}).superRefine((value, ctx) => {
  if (value.STORAGE_PROVIDER.toLowerCase() === "local") {
    return;
  }
  if (!z.string().url().safeParse(value.STORAGE_ENDPOINT).success) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["STORAGE_ENDPOINT"],
      message: "STORAGE_ENDPOINT must be a valid URL unless STORAGE_PROVIDER=local",
    });
  }
  if (!value.STORAGE_ACCESS_KEY_ID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["STORAGE_ACCESS_KEY_ID"],
      message: "STORAGE_ACCESS_KEY_ID is required unless STORAGE_PROVIDER=local",
    });
  }
  if (!value.STORAGE_SECRET_ACCESS_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["STORAGE_SECRET_ACCESS_KEY"],
      message: "STORAGE_SECRET_ACCESS_KEY is required unless STORAGE_PROVIDER=local",
    });
  }
});

export const config = envSchema.parse(process.env);

export const planRules = {
  monthly: { label: "月卡", days: 31, priceCents: 9900 },
  quarterly: { label: "季卡", days: 92, priceCents: 24900 },
  yearly: { label: "年卡", days: 365, priceCents: 89900 },
} as const;

export type PlanCode = keyof typeof planRules;
