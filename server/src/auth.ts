import type { FastifyReply, FastifyRequest } from "fastify";
import { config } from "./config.js";
import { pool } from "./db.js";
import { AppError } from "./errors.js";
import { sha256Hex, verifyAdminToken, verifyAuthToken } from "./security.js";

export interface CurrentAdmin {
  phone: string;
  userId: string | null;
  sessionId: string;
}

export interface CurrentUser {
  id: string;
  phone: string;
  role: "member" | "beta" | "admin";
  roles: Array<"member" | "beta" | "admin">;
  deviceId: string;
  membershipPlan: string | null;
  membershipExpiresAt: string | null;
}

declare module "fastify" {
  interface FastifyRequest {
    currentUser?: CurrentUser;
    currentAdmin?: CurrentAdmin;
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
      COALESCE(role_set.roles, ARRAY[u.role]) AS roles,
      d.id AS device_id
    FROM users u
    LEFT JOIN LATERAL (SELECT array_agg(user_roles.role ORDER BY user_roles.role) AS roles FROM user_roles WHERE user_roles.user_id = u.id) role_set ON TRUE
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
    roles: row.roles,
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

export async function requireAdminSession(request: FastifyRequest, _reply: FastifyReply) {
  assertAdminIpAllowed(request);
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (!token) throw new AppError(401, "ADMIN_AUTH_REQUIRED", "Administrator login is required");
  const payload = verifyAdminToken(token);
  const result = await pool.query(
    "SELECT account.phone, account.user_id FROM admin_accounts account JOIN admin_sessions session ON session.id = $2 AND session.admin_phone = account.phone AND session.token_jti_hash = $3 AND session.revoked_at IS NULL AND session.expires_at > now() WHERE account.phone = $1 AND account.is_active = TRUE LIMIT 1",
    [payload.sub, payload.sessionId, sha256Hex(payload.jti)],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(401, "ADMIN_AUTH_EXPIRED", "Administrator session has expired");
  request.currentAdmin = { phone: row.phone, userId: row.user_id ?? null, sessionId: payload.sessionId };
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
