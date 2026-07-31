import { pool } from "./db.js";
import { AppError } from "./errors.js";

export interface AiSettingsPublic {
  imageProvider: string;
  imageBaseUrl: string;
  imageModel: string;
  imageApiKeyStored: boolean;
  imageApiKeyMasked?: string;
  textProvider: string;
  textBaseUrl: string;
  textModel: string;
  textApiKeyStored: boolean;
  textApiKeyMasked?: string;
  imagePromptTemplate: string;
  titlePromptTemplate: string;
  descriptionPromptTemplate: string;
  updatedAt: string;
}

export interface AiSettingsSecret extends AiSettingsPublic {
  imageApiKey: string;
  textApiKey: string;
}

export async function readAiSettings(): Promise<AiSettingsSecret> {
  const result = await pool.query(
    `
    SELECT
      image_provider,
      image_base_url,
      image_model,
      image_api_key,
      text_provider,
      text_base_url,
      text_model,
      text_api_key,
      image_prompt_template,
      title_prompt_template,
      description_prompt_template,
      updated_at
    FROM ai_settings
    WHERE id = TRUE
    LIMIT 1
    `,
  );
  const row = result.rows[0];
  if (!row) {
    throw new AppError(500, "AI_SETTINGS_MISSING", "AI 设置未初始化，请先执行数据库迁移");
  }
  return mapAiSettings(row);
}

export function toPublicAiSettings(settings: AiSettingsSecret): AiSettingsPublic {
  return {
    imageProvider: settings.imageProvider,
    imageBaseUrl: settings.imageBaseUrl,
    imageModel: settings.imageModel,
    imageApiKeyStored: settings.imageApiKeyStored,
    imageApiKeyMasked: maskSecret(settings.imageApiKey),
    textProvider: settings.textProvider,
    textBaseUrl: settings.textBaseUrl,
    textModel: settings.textModel,
    textApiKeyStored: settings.textApiKeyStored,
    textApiKeyMasked: maskSecret(settings.textApiKey),
    imagePromptTemplate: settings.imagePromptTemplate,
    titlePromptTemplate: settings.titlePromptTemplate,
    descriptionPromptTemplate: settings.descriptionPromptTemplate,
    updatedAt: settings.updatedAt,
  };
}

export function maskSecret(value: string) {
  const secret = value.trim();
  if (!secret) {
    return undefined;
  }
  if (secret.length <= 8) {
    return `${secret.slice(0, 2)}****${secret.slice(-2)}`;
  }
  return `${secret.slice(0, 6)}${"*".repeat(Math.min(12, Math.max(6, secret.length - 10)))}${secret.slice(-4)}`;
}

function mapAiSettings(row: Record<string, unknown>): AiSettingsSecret {
  const imageApiKey = String(row.image_api_key ?? "");
  const textApiKey = String(row.text_api_key ?? "");
  return {
    imageProvider: String(row.image_provider ?? "pixel"),
    imageBaseUrl: String(row.image_base_url ?? "https://ai-pixel.online/v1"),
    imageModel: String(row.image_model ?? "gpt-image-2"),
    imageApiKey,
    imageApiKeyStored: imageApiKey.trim().length > 0,
    textProvider: String(row.text_provider ?? "xiaoqian"),
    textBaseUrl: String(row.text_base_url ?? "https://xiaoqian.art/v1"),
    textModel: String(row.text_model ?? "gpt-5-high"),
    textApiKey,
    textApiKeyStored: textApiKey.trim().length > 0,
    imagePromptTemplate: String(row.image_prompt_template ?? ""),
    titlePromptTemplate: String(row.title_prompt_template ?? ""),
    descriptionPromptTemplate: String(row.description_prompt_template ?? ""),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : new Date(String(row.updated_at)).toISOString(),
  };
}
