import assert from "node:assert/strict";

const baseUrl = process.env.PUBLIC_API_BASE_URL || "http://127.0.0.1:8787";
const adminToken = process.env.ADMIN_TOKEN || "change-me-admin-token";
const suffix = Date.now().toString().slice(-8);
const phone = `188${suffix}`;
const password = `Pass_${suffix}`;
const deviceFingerprint = `local-smoke-${suffix}`;

async function request(path: string, options: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} HTTP ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

const health = await request("/health");
assert.equal(health.ok, true);

const keys = await request("/admin/license-keys", {
  method: "POST",
  headers: {
    "x-admin-token": adminToken,
  },
  body: JSON.stringify({ plan: "monthly", count: 1 }),
});
assert.equal(keys.ok, true);
assert.equal(keys.keys.length, 1);

const registered = await request("/auth/register", {
  method: "POST",
  body: JSON.stringify({
    phone,
    password,
    licenseKey: keys.keys[0].key,
    deviceFingerprint,
    deviceName: "本地烟测电脑",
  }),
});
assert.equal(registered.ok, true);
assert.ok(registered.token);

const shop = await request("/shops/upsert", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${registered.token}`,
  },
  body: JSON.stringify({
    externalShopId: "local-shop",
    name: "本地测试店铺",
    ozonClientId: "local-client",
  }),
});
assert.equal(shop.ok, true);

const assets = await request("/gallery/assets?hideUsed=true", {
  headers: {
    Authorization: `Bearer ${registered.token}`,
  },
});
assert.equal(assets.ok, true);
assert.ok(Array.isArray(assets.assets));

console.log("烟测通过：health、授权密钥、注册登录、店铺同步、图库列表均正常。");
