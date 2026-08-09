import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config, planRules, type PlanCode } from "../config.js";
import { requireAuth } from "../auth.js";
import { pool, withTransaction } from "../db.js";
import { AppError } from "../errors.js";
import { createAuthToken, newId, sha256Hex, verifyAuthToken } from "../security.js";
import { computeUserFeatures, invalidateFeatureFlagsCache } from "../feature-service.js";

const registerSchema = z.object({
  phone: z.string().min(5).max(32),
  password: z.string().min(6).max(100),
  displayName: z.string().max(80).optional(),
  licenseKey: z.string().optional(),
  deviceFingerprint: z.string().min(8).max(300),
  deviceName: z.string().max(120).optional(),
});

const loginSchema = z.object({
  phone: z.string().min(5).max(32),
  password: z.string().min(6).max(100),
  deviceFingerprint: z.string().min(8).max(300),
  deviceName: z.string().max(120).optional(),
});

const redeemSchema = z.object({
  licenseKey: z.string().min(12),
});

export async function authRoutes(app: FastifyInstance) {
  app.post("/auth/register", async (request) => {
    const body = registerSchema.parse(request.body);
    const passwordHash = await bcrypt.hash(body.password, 12);
    const userId = newId();
    const deviceHash = sha256Hex(body.deviceFingerprint);

    return withTransaction(async (client) => {
      const existing = await client.query("SELECT id FROM users WHERE phone = $1", [body.phone]);
      if (existing.rowCount) {
        throw new AppError(409, "PHONE_EXISTS", "手机号已注册，请直接登录");
      }

      const role = body.phone === config.SUPER_ADMIN_PHONE ? "admin" : "member";

      await client.query(
        `
        INSERT INTO users (id, phone, password_hash, display_name, role, last_login_at)
        VALUES ($1, $2, $3, $4, $5, now())
        `,
        [userId, body.phone, passwordHash, body.displayName ?? null, role],
      );

      const deviceId = await bindDevice(client, userId, deviceHash, body.deviceName);
      if (body.licenseKey) {
        await redeemLicenseKey(client, userId, body.licenseKey);
      }

      const token = createAuthToken(userId, deviceId);
      await saveSession(client, userId, deviceId, token.jti, token.expiresAt);
      const user = await readUser(client, userId);
      return { ok: true, token: token.token, user };
    });
  });

  app.post("/auth/login", async (request) => {
    const body = loginSchema.parse(request.body);
    const result = await pool.query("SELECT * FROM users WHERE phone = $1", [body.phone]);
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(body.password, row.password_hash))) {
      throw new AppError(401, "LOGIN_FAILED", "手机号或密码不正确");
    }

    const deviceHash = sha256Hex(body.deviceFingerprint);
    return withTransaction(async (client) => {
      // 超级管理员存量回填：如果该手机号匹配但 role 还不是 admin，自动升级
      if (body.phone === config.SUPER_ADMIN_PHONE && row.role !== "admin") {
        await client.query("UPDATE users SET role = 'admin', updated_at = now() WHERE id = $1", [row.id]);
        row.role = "admin";
      }

      const deviceId = await bindDevice(client, row.id, deviceHash, body.deviceName);
      await recordUserLogin(client, row.id);
      const token = createAuthToken(row.id, deviceId);
      await saveSession(client, row.id, deviceId, token.jti, token.expiresAt);
      const user = await readUser(client, row.id);
      return { ok: true, token: token.token, user };
    });
  });

  app.get("/me", { preHandler: requireAuth }, async (request) => {
    const user = request.currentUser!;
    const features = await computeUserFeatures(user.id, user.roles);
    return { ok: true, user, features };
  });

  app.post("/license/redeem", { preHandler: requireAuth }, async (request) => {
    const body = redeemSchema.parse(request.body);
    const userId = request.currentUser!.id;
    return withTransaction(async (client) => {
      const membership = await redeemLicenseKey(client, userId, body.licenseKey);
      return { ok: true, membership };
    });
  });

  app.post("/auth/logout", { preHandler: requireAuth }, async (request) => {
    const header = request.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (token) {
      const payload = verifyAuthToken(token);
      await pool.query("UPDATE user_sessions SET revoked_at = now() WHERE token_jti_hash = $1", [sha256Hex(payload.jti)]);
    }
    return { ok: true };
  });
}

async function bindDevice(client: { query: typeof pool.query }, userId: string, fingerprintHash: string, deviceName?: string) {
  const active = await client.query(
    "SELECT id, fingerprint_hash FROM devices WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1",
    [userId],
  );
  const row = active.rows[0];
  if (row && row.fingerprint_hash !== fingerprintHash) {
    throw new AppError(409, "DEVICE_LIMIT_REACHED", "该账号已绑定另一台电脑，请联系管理员解绑后再登录");
  }
  if (row) {
    await client.query("UPDATE devices SET last_seen_at = now(), device_name = COALESCE($2, device_name) WHERE id = $1", [
      row.id,
      deviceName ?? null,
    ]);
    return row.id as string;
  }

  const deviceId = newId();
  await client.query(
    "INSERT INTO devices (id, user_id, fingerprint_hash, device_name) VALUES ($1, $2, $3, $4)",
    [deviceId, userId, fingerprintHash, deviceName ?? null],
  );
  return deviceId;
}

async function saveSession(client: { query: typeof pool.query }, userId: string, deviceId: string, jti: string, expiresAt: Date) {
  await client.query(
    `
    INSERT INTO user_sessions (id, user_id, device_id, token_jti_hash, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    `,
    [newId(), userId, deviceId, sha256Hex(jti), expiresAt],
  );
}

async function recordUserLogin(client: { query: typeof pool.query }, userId: string) {
  await client.query("UPDATE users SET last_login_at = now(), updated_at = now() WHERE id = $1", [userId]);
}

async function redeemLicenseKey(client: { query: typeof pool.query }, userId: string, rawKey: string) {
  const keyHash = sha256Hex(rawKey.trim());
  const keyResult = await client.query("SELECT * FROM authorization_keys WHERE key_hash = $1 FOR UPDATE", [keyHash]);
  const key = keyResult.rows[0];
  if (!key || key.status !== "unused") {
    throw new AppError(400, "LICENSE_INVALID", "授权密钥无效或已被使用");
  }

  const userResult = await client.query("SELECT membership_expires_at FROM users WHERE id = $1 FOR UPDATE", [userId]);
  const user = userResult.rows[0];
  if (!user) {
    throw new AppError(404, "USER_NOT_FOUND", "账号不存在");
  }

  const plan = key.plan as PlanCode;
  const rule = planRules[plan];
  const currentExpiry = user.membership_expires_at ? new Date(user.membership_expires_at).getTime() : 0;
  const startAt = Math.max(Date.now(), currentExpiry);
  const expiresAt = new Date(startAt + rule.days * 24 * 60 * 60 * 1000);

  await client.query(
    `
    UPDATE users
    SET membership_plan = $2,
        membership_expires_at = $3,
        updated_at = now()
    WHERE id = $1
    `,
    [userId, plan, expiresAt],
  );

  await client.query(
    `
    UPDATE authorization_keys
    SET status = 'redeemed',
        assigned_user_id = $2,
        redeemed_at = now(),
        expires_at = $3,
        key_plain = NULL
    WHERE id = $1
    `,
    [key.id, userId, expiresAt],
  );

  return {
    plan,
    planLabel: rule.label,
    expiresAt: expiresAt.toISOString(),
  };
}

async function readUser(client: { query: typeof pool.query }, userId: string) {
  const result = await client.query(
    `
    SELECT
      u.id,
      u.phone,
      u.display_name,
      u.role,
      u.membership_plan,
      u.membership_expires_at,
      u.gallery_storage_limit_bytes,
      COALESCE(sum(a.size_bytes), 0)::bigint AS gallery_storage_used_bytes
    FROM users u
    LEFT JOIN gallery_assets a
      ON a.uploaded_by_user_id = u.id
      AND a.deleted_at IS NULL
      AND NOT EXISTS (
        SELECT 1
        FROM gallery_mockup_results mr
        WHERE mr.result_asset_id = a.id
      )
    WHERE u.id = $1
    GROUP BY u.id
    `,
    [userId],
  );
  const row = result.rows[0];
  return {
    id: row.id,
    phone: row.phone,
    displayName: row.display_name,
    role: row.role,
    membershipPlan: row.membership_plan,
    membershipExpiresAt: row.membership_expires_at ? new Date(row.membership_expires_at).toISOString() : null,
    galleryStorageUsedBytes: Number(row.gallery_storage_used_bytes ?? 0),
    galleryStorageLimitBytes: Number(row.gallery_storage_limit_bytes ?? 0),
  };
}
