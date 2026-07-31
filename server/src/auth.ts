import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { pool } from "./db.js";
import { AppError } from "./errors.js";
import { sha256Hex, verifyAuthToken } from "./security.js";

export interface CurrentUser {
  id: string;
  phone: string;
  role: "member" | "admin";
  deviceId: string;
  membershipPlan: string | null;
  membershipExpiresAt: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: CurrentUser;
  }
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply) {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) {
    throw new AppError(401, "AUTH_REQUIRED", "请先登录");
  }

  const payload = verifyAuthToken(token);
  const tokenHash = sha256Hex(payload.jti);
  const result = await pool.query(
    `
    SELECT
      u.id,
      u.phone,
      u.role,
      u.membership_plan,
      u.membership_expires_at,
      d.id AS device_id
    FROM users u
    JOIN devices d ON d.id = $2 AND d.user_id = u.id AND d.revoked_at IS NULL
    JOIN user_sessions s ON s.user_id = u.id
      AND s.device_id = d.id
      AND s.token_jti_hash = $3
      AND s.revoked_at IS NULL
      AND s.expires_at > now()
    WHERE u.id = $1
    LIMIT 1
    `,
    [payload.sub, payload.deviceId, tokenHash],
  );

  const row = result.rows[0];
  if (!row) {
    throw new AppError(401, "AUTH_EXPIRED", "登录已失效，请重新登录");
  }

  request.currentUser = {
    id: row.id,
    phone: row.phone,
    role: row.role,
    deviceId: row.device_id,
    membershipPlan: row.membership_plan,
    membershipExpiresAt: row.membership_expires_at ? new Date(row.membership_expires_at).toISOString() : null,
  };

  await pool.query(
    "UPDATE devices SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '60 seconds'",
    [row.device_id],
  );
}

export async function requireMembership(request: FastifyRequest) {
  const user = request.currentUser;
  if (!user) {
    throw new AppError(401, "AUTH_REQUIRED", "请先登录");
  }
  if (!user.membershipExpiresAt || new Date(user.membershipExpiresAt).getTime() <= Date.now()) {
    throw new AppError(402, "MEMBERSHIP_REQUIRED", "会员已过期，请先兑换授权密钥");
  }
}

export async function requireAdminToken(request: FastifyRequest) {
  assertAdminIpAllowed(request);
  const token = request.headers["x-admin-token"];
  const value = Array.isArray(token) ? token[0] : token;
  if (!value || value !== process.env.ADMIN_TOKEN) {
    throw new AppError(401, "ADMIN_TOKEN_INVALID", "管理员口令不正确");
  }
}

function assertAdminIpAllowed(request: FastifyRequest) {
  const allowlist = config.ADMIN_IP_ALLOWLIST
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (allowlist.length === 0) {
    return;
  }
  const forwarded = String(request.headers["x-forwarded-for"] ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const candidates = new Set([request.ip, ...forwarded]);
  if (!allowlist.some((ip) => candidates.has(ip))) {
    throw new AppError(403, "ADMIN_IP_FORBIDDEN", "当前 IP 不允许访问管理员接口");
  }
}
