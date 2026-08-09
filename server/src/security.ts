import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { config } from "./config.js";

export interface AuthTokenPayload {
  sub: string;
  deviceId: string;
  jti: string;
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function newId(): string {
  return crypto.randomUUID();
}

export function createAuthToken(userId: string, deviceId: string) {
  const jti = newId();
  const expiresInSeconds = 60 * 60 * 24 * 30;
  const token = jwt.sign({ deviceId }, config.JWT_SECRET, {
    algorithm: "HS256",
    expiresIn: expiresInSeconds,
    jwtid: jti,
    subject: userId,
  });
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);
  return { token, jti, expiresAt };
}

export function verifyAuthToken(token: string): AuthTokenPayload {
  const payload = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
  if (!payload.sub || typeof payload.deviceId !== "string" || typeof payload.jti !== "string") {
    throw new Error("登录令牌无效");
  }
  return {
    sub: payload.sub,
    deviceId: payload.deviceId,
    jti: payload.jti,
  };
}

export interface AdminTokenPayload {
  sub: string;
  sessionId: string;
  jti: string;
}

export function createAdminToken(phone: string, sessionId: string) {
  const jti = newId();
  const expiresInSeconds = 60 * 60 * 8;
  const token = jwt.sign({ scope: "admin", sessionId }, config.JWT_SECRET, { algorithm: "HS256", expiresIn: expiresInSeconds, jwtid: jti, subject: phone });
  return { token, jti, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
}

export function verifyAdminToken(token: string): AdminTokenPayload {
  const payload = jwt.verify(token, config.JWT_SECRET) as jwt.JwtPayload;
  if (payload.scope !== "admin" || !payload.sub || typeof payload.sessionId !== "string" || typeof payload.jti !== "string") {
    throw new Error("Administrator token is invalid");
  }
  return { sub: payload.sub, sessionId: payload.sessionId, jti: payload.jti };
}

export function makeLicenseKey(): string {
  const body = crypto.randomBytes(18).toString("base64url").toUpperCase();
  return `OSJ-${body.slice(0, 6)}-${body.slice(6, 12)}-${body.slice(12, 18)}-${body.slice(18, 24)}`;
}
