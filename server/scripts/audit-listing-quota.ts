import "dotenv/config";
import { pool } from "../src/db.js";

const DEFAULT_DAILY_LISTING_LIMIT = 300;

type UserRow = {
  id: string;
  phone: string;
};

type ShopRow = {
  user_id: string;
  shop_id: string;
  external_shop_id: string;
  shop_name: string;
};

type PreferenceRow = {
  user_id: string;
  preferences: unknown;
};

type QuotaRow = {
  user_id: string;
  shop_id: string;
  external_shop_id: string;
  shop_name: string;
  completed_today: number;
  pending_backlog: number;
  reserved_today: number;
  failed_rows: number;
  created_today: number;
  oldest_pending_at: Date | null;
  latest_activity_at: Date | null;
  snapshot_limits: string[] | null;
};

const phone = process.env.LISTING_QUOTA_AUDIT_PHONE?.trim();
const userId = process.env.LISTING_QUOTA_AUDIT_USER_ID?.trim();
const externalShopId = process.env.LISTING_QUOTA_AUDIT_EXTERNAL_SHOP_ID?.trim();
const statDate = process.env.LISTING_QUOTA_AUDIT_DATE?.trim() || localDateString(new Date());
const showEmpty = booleanEnv(process.env.LISTING_QUOTA_AUDIT_SHOW_EMPTY, false);

try {
  const users = await loadUsers();
  const userIds = users.map((user) => user.id);
  const [shops, preferences, quotas] = userIds.length
    ? await Promise.all([
      loadShops(userIds),
      loadPreferences(userIds),
      loadQuotas(userIds),
    ])
    : [[], new Map<string, unknown>(), new Map<string, QuotaRow>()] as const;

  const quotaLimits = buildQuotaLimits(preferences);
  const rows = shops
    .map((shop) => {
      const quota = quotas.get(`${shop.user_id}:${shop.shop_id}`);
      const configuredLimit = quotaLimits.get(`${shop.user_id}:${shop.external_shop_id}`) ?? DEFAULT_DAILY_LISTING_LIMIT;
      const reservedToday = quota?.reserved_today ?? 0;
      const completedToday = quota?.completed_today ?? 0;
      const pendingBacklog = quota?.pending_backlog ?? 0;
      const remaining = Math.max(0, configuredLimit - reservedToday);
      const overBy = Math.max(0, reservedToday - configuredLimit);
      const snapshotLimits = normalizeSnapshotLimits(quota?.snapshot_limits);
      return {
        phone: users.find((user) => user.id === shop.user_id)?.phone ?? "",
        userId: shop.user_id,
        shopId: shop.shop_id,
        externalShopId: shop.external_shop_id,
        shopName: quota?.shop_name || shop.shop_name,
        date: statDate,
        configuredLimit,
        reservedToday,
        completedToday,
        pendingBacklog,
        remaining,
        overBy,
        createdToday: quota?.created_today ?? 0,
        failedRows: quota?.failed_rows ?? 0,
        oldestPendingAt: quota?.oldest_pending_at?.toISOString() ?? null,
        latestActivityAt: quota?.latest_activity_at?.toISOString() ?? null,
        snapshotLimits,
        status: overBy > 0 ? "over_limit" : remaining === 0 ? "full" : pendingBacklog > 0 ? "has_backlog" : "available",
      };
    })
    .filter((row) => showEmpty || row.reservedToday > 0 || row.configuredLimit !== DEFAULT_DAILY_LISTING_LIMIT)
    .sort((left, right) => (
      right.reservedToday - left.reservedToday
      || right.completedToday - left.completedToday
      || left.shopName.localeCompare(right.shopName, "zh-CN")
    ));

  console.log(JSON.stringify({
    ok: true,
    filters: {
      phone: phone || null,
      userId: userId || null,
      externalShopId: externalShopId || null,
      date: statDate,
      showEmpty,
    },
    summary: {
      userCount: users.length,
      shopCount: shops.length,
      reportedShopCount: rows.length,
      overLimitShopCount: rows.filter((row) => row.overBy > 0).length,
      fullShopCount: rows.filter((row) => row.remaining === 0).length,
      reservedToday: rows.reduce((sum, row) => sum + row.reservedToday, 0),
      completedToday: rows.reduce((sum, row) => sum + row.completedToday, 0),
      pendingBacklog: rows.reduce((sum, row) => sum + row.pendingBacklog, 0),
    },
    shops: rows,
  }, null, 2));
} finally {
  await pool.end();
}

async function loadUsers() {
  const values: unknown[] = [];
  const filters: string[] = [];
  if (phone) {
    values.push(phone);
    filters.push(`phone = $${values.length}`);
  }
  if (userId) {
    values.push(userId);
    filters.push(`id = $${values.length}`);
  }
  const whereSql = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const result = await pool.query<UserRow>(
    `
    SELECT id::text, phone
    FROM users
    ${whereSql}
    ORDER BY created_at DESC
    `,
    values,
  );
  return result.rows;
}

async function loadShops(userIds: string[]) {
  const values: unknown[] = [userIds];
  const filters = ["user_id = ANY($1::uuid[])"];
  if (externalShopId) {
    values.push(externalShopId);
    filters.push(`external_shop_id = $${values.length}`);
  }
  const result = await pool.query<ShopRow>(
    `
    SELECT
      user_id::text,
      id::text AS shop_id,
      external_shop_id,
      name AS shop_name
    FROM shops
    WHERE ${filters.join(" AND ")}
    ORDER BY name ASC
    `,
    values,
  );
  return result.rows;
}

async function loadPreferences(userIds: string[]) {
  const result = await pool.query<PreferenceRow>(
    `
    SELECT user_id::text, preferences
    FROM gallery_listing_preferences
    WHERE user_id = ANY($1::uuid[])
    `,
    [userIds],
  );
  return new Map(result.rows.map((row) => [row.user_id, row.preferences]));
}

async function loadQuotas(userIds: string[]) {
  const values: unknown[] = [userIds, statDate];
  const filters = ["lba.user_id = ANY($1::uuid[])"];
  if (externalShopId) {
    values.push(externalShopId);
    filters.push(`lba.external_shop_id = $${values.length}`);
  }
  const result = await pool.query<QuotaRow>(
    `
    WITH scoped AS (
      SELECT
        lba.*,
        EXISTS (
          SELECT 1
          FROM jsonb_each(COALESCE(lba.stage_progress, '{}'::jsonb)) AS stage(_, value)
          WHERE stage.value->>'status' = 'failed'
        ) AS has_failed_stage
      FROM gallery_listing_batch_assets lba
      WHERE ${filters.join(" AND ")}
    )
    SELECT
      user_id::text,
      shop_id::text,
      (array_agg(external_shop_id ORDER BY COALESCE(listing_completed_at, updated_at, created_at) DESC))[1] AS external_shop_id,
      (array_agg(shop_name ORDER BY COALESCE(listing_completed_at, updated_at, created_at) DESC))[1] AS shop_name,
      count(*) FILTER (
        WHERE NOT has_failed_stage
          AND listing_completed_at IS NOT NULL
          AND (listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date = $2::date
      )::int AS completed_today,
      count(*) FILTER (
        WHERE NOT has_failed_stage
          AND listing_completed_at IS NULL
      )::int AS pending_backlog,
      count(*) FILTER (
        WHERE NOT has_failed_stage
          AND (
            (
              listing_completed_at IS NULL
              AND (created_at AT TIME ZONE 'Asia/Shanghai')::date = $2::date
            )
            OR (listing_completed_at AT TIME ZONE 'Asia/Shanghai')::date = $2::date
          )
      )::int AS reserved_today,
      count(*) FILTER (WHERE has_failed_stage)::int AS failed_rows,
      count(*) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Shanghai')::date = $2::date)::int AS created_today,
      min(created_at) FILTER (WHERE NOT has_failed_stage AND listing_completed_at IS NULL) AS oldest_pending_at,
      max(COALESCE(listing_completed_at, updated_at, created_at)) AS latest_activity_at,
      array_remove(array_agg(DISTINCT config_snapshot->>'dailyListingLimit'), NULL) AS snapshot_limits
    FROM scoped
    GROUP BY user_id, shop_id
    `,
    values,
  );
  return new Map(result.rows.map((row) => [`${row.user_id}:${row.shop_id}`, row]));
}

function buildQuotaLimits(preferencesByUserId: Map<string, unknown>) {
  const limits = new Map<string, number>();
  for (const [preferenceUserId, preferences] of preferencesByUserId) {
    const configs = readShopListingConfigs(preferences);
    for (const config of configs) {
      const externalShopIdValue = typeof config.externalShopId === "string" ? config.externalShopId.trim() : "";
      if (!externalShopIdValue) {
        continue;
      }
      limits.set(`${preferenceUserId}:${externalShopIdValue}`, normalizePositiveInt(config.dailyListingLimit, DEFAULT_DAILY_LISTING_LIMIT));
    }
  }
  return limits;
}

function readShopListingConfigs(preferences: unknown): Array<Record<string, unknown>> {
  if (!preferences || typeof preferences !== "object") {
    return [];
  }
  const configs = (preferences as { shopListingConfigs?: unknown }).shopListingConfigs;
  return Array.isArray(configs)
    ? configs.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
    : [];
}

function normalizeSnapshotLimits(values: string[] | null | undefined) {
  return [...new Set((values ?? []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function normalizePositiveInt(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function booleanEnv(value: string | undefined, fallback: boolean) {
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function localDateString(date: Date) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return formatter.format(date);
}
