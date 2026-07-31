# Task 2 review snapshot

## Brief
# Task 2 — Normalize Existing Account and License Management APIs

Plan: docs/superpowers/plans/2026-07-30-admin-console-redesign.md

Precondition: Task 1 must provide `adminListQuerySchema` and migration lifecycle fields.

Ownership:
- server/src/routes/admin-routes.ts (user and license route blocks only)
- server/src/public/admin/admin.js (account and license controller regions only, after Task 5 creates the file)

Constraints:
- Lists return `{ ok, items, total, limit, offset }` with `limit=10` default.
- Use logical DELETE and POST restore only.
- Preserve current admin token auth, current license batch generation, bindings, and user device/storage behavior.
- Do not edit Gallery, Featured Gallery, Orders, Rules, Mockups, AI, HTML, CSS, or migrations.
- Frontend changes wait until Task 5 asset split is complete; if it is not complete, implement and test server work only and record the deferment.
- You are not alone in the codebase. Do not revert other agents' changes.


## Report
# Task 2 Report 鈥?Account and License Management APIs

Date: 2026-07-30

## Changed paths

- `E:\tool\ozon_sjsq\server\src\routes\admin-routes.ts`
- `E:\tool\ozon_sjsq\server\src\admin-pagination.test.ts`

Task 1's `E:\tool\ozon_sjsq\server\src\admin-pagination.ts` was preserved unchanged.

## Implementation

- User and license list routes consume the shared ten-row query schema and apply `adminDeletionClause` to both count and list queries.
- Lists now return `items`, `total`, `limit`, and `offset`, while retaining `users` and `keys` compatibility aliases.
- Added `PUT` and `POST .../restore` routes for users and license keys.
- User edits cover display name and membership fields.
- License edits cover plan, expiry, and status while recalculating plan-derived days/price and protecting existing binding rules.
- User and unused-license deletion now set `deleted_at` and `deleted_by = 'admin'`; restore clears both fields.
- Existing license batch generation, device unbinding, and storage-limit behavior remain unchanged.

## TDD and test results

1. Added lifecycle endpoint assertions before production route changes.
2. Ran the new test from the server context and observed the expected red failure: 2 existing tests passed and the new contract test failed because PUT/restore routes were absent.
3. After implementation:
   - `node --import tsx --test src/admin-pagination.test.ts` 鈥?**3 passed, 0 failed**.
   - `npm test` 鈥?**28 passed, 0 failed**.
   - `npm run check` 鈥?**passed** with exit code 0.

The initial equivalent command from the repository root could not resolve the server-local `tsx` package; rerunning with `server` as the working directory reached the intended test failure.

## Self-review

- Confirmed the default active state remains supplied by `adminListQuerySchema`.
- Confirmed user and license deletion clauses are shared by their count and paginated list SQL.
- Confirmed no physical `DELETE` remains for users, authorization keys, or gallery assets in `admin-routes.ts`.
- Confirmed admin users remain protected from deletion.
- Confirmed deleted rows expose restore actions through the new routes and lifecycle fields in list/detail responses.
- Confirmed no migration, gallery, order, rules, mockup, AI, HTML, or CSS files were changed.

## Blockers and deferments

- `E:\tool\ozon_sjsq\server\src\public\admin\admin.js` does not exist yet because the Task 5 asset split is not complete. Account/license frontend controller changes were intentionally deferred per the Task 2 brief.
- No other implementation blockers remain.


## Test
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { adminListQuerySchema, adminDeletionClause } from "./admin-pagination.js";

test("admin lists default to ten active records", () => {
  assert.deepEqual(adminListQuerySchema.parse({}), { limit: 10, offset: 0, deletionState: "active" });
  assert.equal(adminDeletionClause("a", "active"), "a.deleted_at IS NULL");
});

test("admin lists can request deleted and all records", () => {
  assert.equal(adminDeletionClause("a", "deleted"), "a.deleted_at IS NOT NULL");
  assert.equal(adminDeletionClause("a", "all"), "TRUE");
});

test("admin account and license routes expose lifecycle contracts", () => {
  const routes = readFileSync(fileURLToPath(new URL("./routes/admin-routes.ts", import.meta.url)), "utf8");

  assert.match(routes, /app\.put\("\/admin\/users\/:userId"/);
  assert.match(routes, /app\.post\("\/admin\/users\/:userId\/restore"/);
  assert.match(routes, /app\.put\("\/admin\/license-keys\/:keyId"/);
  assert.match(routes, /app\.post\("\/admin\/license-keys\/:keyId\/restore"/);
  assert.match(routes, /adminDeletionClause\("u", query\.deletionState\)/);
  assert.match(routes, /adminDeletionClause\("k", query\.deletionState\)/);
  assert.ok((routes.match(/items: result\.rows/g) ?? []).length >= 2);
});


## Relevant route section
          image_base_url = EXCLUDED.image_base_url,
          image_model = EXCLUDED.image_model,
          image_api_key = COALESCE(EXCLUDED.image_api_key, ai_settings.image_api_key),
          text_provider = EXCLUDED.text_provider,
          text_base_url = EXCLUDED.text_base_url,
          text_model = EXCLUDED.text_model,
          text_api_key = COALESCE(EXCLUDED.text_api_key, ai_settings.text_api_key),
          image_prompt_template = EXCLUDED.image_prompt_template,
          title_prompt_template = EXCLUDED.title_prompt_template,
          description_prompt_template = EXCLUDED.description_prompt_template,
          updated_at = now()
      `,
      [
        body.imageProvider.trim(),
        body.imageBaseUrl.trim().replace(/\/+$/, ""),
        body.imageModel.trim(),
        nextImageApiKey,
        body.textProvider.trim(),
        body.textBaseUrl.trim().replace(/\/+$/, ""),
        body.textModel.trim(),
        nextTextApiKey,
        body.imagePromptTemplate,
        body.titlePromptTemplate,
        body.descriptionPromptTemplate,
      ],
    );
    const settings = await readAiSettings();
    return { ok: true, settings: toPublicAiSettings(settings) };
  });

  app.post("/admin/license-keys", { preHandler: requireAdminToken }, async (request) => {
    request.log.info("admin license key creation started");
    const body = createKeysSchema.parse(request.body);
    const rule = planRules[body.plan as PlanCode];
    const keys: Array<{ key: string; plan: string; priceYuan: number; days: number }> = [];

    for (let index = 0; index < body.count; index += 1) {
      const key = makeLicenseKey();
      request.log.info({ index, plan: body.plan }, "inserting authorization key");
      await pool.query(
        `
        INSERT INTO authorization_keys (id, key_hash, key_prefix, key_plain, plan, days, price_cents)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        `,
        [newId(), sha256Hex(key), key.slice(0, 12), key, body.plan, rule.days, rule.priceCents],
      );
      request.log.info({ index, plan: body.plan }, "authorization key inserted");
      keys.push({
        key,
        plan: body.plan,
        priceYuan: rule.priceCents / 100,
        days: rule.days,
      });
    }

    request.log.info({ count: keys.length, plan: body.plan }, "admin license key creation completed");
    return { ok: true, keys };
  });

  app.get("/admin/license-keys", { preHandler: requireAdminToken }, async (request) => {
    const query = licenseKeysQuerySchema.parse(request.query);
    const values: unknown[] = [];
    const where: string[] = [adminDeletionClause("k", query.deletionState)];

    if (query.status !== "all") {
      values.push(query.status);
      where.push(`k.status = $${values.length}`);
    }
    if (query.plan !== "all") {
      values.push(query.plan);
      where.push(`k.plan = $${values.length}`);
    }
    if (query.keyword) {
      values.push(`%${query.keyword}%`);
      where.push(`(k.key_prefix ILIKE $${values.length} OR COALESCE(u.phone, '') ILIKE $${values.length})`);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countResult = await pool.query(
      `
      SELECT count(*)::int AS total
      FROM authorization_keys k
      LEFT JOIN users u ON u.id = k.assigned_user_id
      ${whereSql}
      `,
      values,
    );

    const listValues = [...values, query.limit, query.offset];
    const limitIndex = listValues.length - 1;
    const offsetIndex = listValues.length;
    const result = await pool.query(
      `
      SELECT
        k.id,
        k.key_prefix,
        CASE WHEN k.status = 'unused' THEN k.key_plain ELSE NULL END AS key_plain,
        k.plan,
        k.days,
        k.price_cents,
        k.status,
        k.redeemed_at,
        k.expires_at,
        k.created_at,
        k.deleted_at,
        k.deleted_by,
        u.phone AS assigned_phone
      FROM authorization_keys k
      LEFT JOIN users u ON u.id = k.assigned_user_id
      ${whereSql}
      ORDER BY k.created_at DESC
      LIMIT $${limitIndex}
      OFFSET $${offsetIndex}
      `,
      listValues,
    );

    return {
      ok: true,
      items: result.rows,
      keys: result.rows,
      total: countResult.rows[0]?.total ?? 0,
      limit: query.limit,
      offset: query.offset,
    };
  });

  app.put("/admin/license-keys/:keyId", { preHandler: requireAdminToken }, async (request) => {
    const params = z.object({ keyId: z.string().uuid() }).parse(request.params);
    const body = licenseKeyUpdateSchema.parse(request.body);
    const currentResult = await pool.query(
      `
      SELECT id, plan, days, price_cents, status, assigned_user_id, expires_at
      FROM authorization_keys
      WHERE id = $1
      `,
      [params.keyId],
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new AppError(404, "LICENSE_KEY_NOT_FOUND", "license key not found");
    }

    const nextPlan = (body.plan ?? current.plan) as PlanCode;
    const nextStatus = body.status ?? current.status;
    if (nextStatus === "unused" && current.assigned_user_id) {
      throw new AppError(400, "LICENSE_KEY_BINDING_REQUIRED", "bound license keys cannot become unused");
    }
    if (nextStatus === "redeemed" && !current.assigned_user_id) {
      throw new AppError(400, "LICENSE_KEY_BINDING_REQUIRED", "redeemed license keys must be bound");
    }

    const rule = planRules[nextPlan];
    const expiresAt = body.expiresAt === undefined ? current.expires_at : body.expiresAt;
    const result = await pool.query(
      `
      UPDATE authorization_keys
      SET plan = $2,
          days = $3,
          price_cents = $4,
          status = $5,
          expires_at = $6
      WHERE id = $1
      RETURNING id, key_prefix, plan, days, price_cents, status, redeemed_at, expires_at, deleted_at, deleted_by
      `,
      [params.keyId, nextPlan, rule.days, rule.priceCents, nextStatus, expiresAt],
    );
    return { ok: true, key: result.rows[0] };
  });

  app.delete("/admin/license-keys/:keyId", { preHandler: requireAdminToken }, async (request) => {
    const params = z.object({ keyId: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `
      UPDATE authorization_keys
      SET deleted_at = now(),
          deleted_by = 'admin'
      WHERE id = $1
        AND status = 'unused'
        AND deleted_at IS NULL
      RETURNING id, deleted_at, deleted_by
      `,
      [params.keyId],
    );
    if (!result.rowCount) {
      throw new AppError(400, "LICENSE_KEY_NOT_DELETABLE", "鍙兘鍒犻櫎鏈娇鐢ㄧ殑鎺堟潈鐮?);
    }
    return { ok: true };
  });

  app.post("/admin/license-keys/:keyId/restore", { preHandler: requireAdminToken }, async (request) => {
    const params = z.object({ keyId: z.string().uuid() }).parse(request.params);
    const result = await pool.query(
      `
      UPDATE authorization_keys
      SET deleted_at = NULL,
          deleted_by = NULL
      WHERE id = $1
        AND deleted_at IS NOT NULL
      RETURNING id, key_prefix, plan, days, price_cents, status, redeemed_at, expires_at, deleted_at, deleted_by
      `,
      [params.keyId],
    );
    if (!result.rowCount) {
      throw new AppError(404, "LICENSE_KEY_NOT_DELETED", "license key is not deleted");
    }
    return { ok: true, key: result.rows[0] };
  });

  app.post("/admin/users/:userId/unbind-device", { preHandler: requireAdminToken }, async (request) => {
    const params = z.object({ userId: z.string().uuid() }).parse(request.params);
    await pool.query(
      `
      UPDATE devices
      SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL
      `,
      [params.userId],
    );
    await pool.query(
      `
      UPDATE user_sessions
      SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL
      `,
      [params.userId],
    );
    return { ok: true };
  });

  app.post("/admin/users/:userId/storage-limit", { preHandler: requireAdminToken }, async (request) => {
    const params = z.object({ userId: z.string().uuid() }).parse(request.params);
    const body = userStorageLimitSchema.parse(request.body);
    const limitBytes = Math.round(body.limitGb * 1024 * 1024 * 1024);
    const result = await pool.query(
      `
      UPDATE users
      SET gallery_storage_limit_bytes = $2,
          updated_at = now()
      WHERE id = $1
      RETURNING id, gallery_storage_limit_bytes
      `,
      [params.userId, limitBytes],
    );
    if (!result.rowCount) {
      throw new AppError(404, "USER_NOT_FOUND", "鐢ㄦ埛涓嶅瓨鍦?);
    }
    return { ok: true, user: result.rows[0] };
  });

  app.put("/admin/users/:userId", { preHandler: requireAdminToken }, async (request) => {
    const params = z.object({ userId: z.string().uuid() }).parse(request.params);
    const body = userUpdateSchema.parse(request.body);
    const values: unknown[] = [params.userId];
    const updates: string[] = [];

    if (body.displayName !== undefined) {
      values.push(body.displayName);
      updates.push(`display_name = $${values.length}`);
    }
    if (body.membershipPlan !== undefined) {
      values.push(body.membershipPlan);
      updates.push(`membership_plan = $${values.length}`);
    }
    if (body.membershipExpiresAt !== undefined) {
      values.push(body.membershipExpiresAt);
      updates.push(`membership_expires_at = $${values.length}`);
    }

    if (updates.length === 0) {
      throw new AppError(400, "USER_UPDATE_EMPTY", "no editable user fields supplied");
    }

    updates.push("updated_at = now()");
    const result = await pool.query(
      `
      UPDATE users
      SET ${updates.join(", ")}
      WHERE id = $1
      RETURNING
        id,
        phone,
        display_name,
        role,
        membership_plan,
        membership_expires_at,
        gallery_storage_limit_bytes,
        last_login_at,
        created_at,
        updated_at,
        deleted_at,
        deleted_by
      `,
      values,
    );
    if (!result.rowCount) {
      throw new AppError(404, "USER_NOT_FOUND", "user not found");
    }
    return { ok: true, user: result.rows[0] };
  });

  app.delete("/admin/users/:userId", { preHandler: requireAdminToken }, async (request) => {
    const params = z.object({ userId: z.string().uuid() }).parse(request.params);
    return withTransaction(async (client) => {
      const userResult = await client.query(
        "SELECT id, role, deleted_at, deleted_by FROM users WHERE id = $1 FOR UPDATE",
        [params.userId],
      );
      const user = userResult.rows[0];
      if (!user) {
        throw new AppError(404, "USER_NOT_FOUND", "鐢ㄦ埛涓嶅瓨鍦?);
      }
      if (user.role === "admin") {
        throw new AppError(400, "ADMIN_USER_NOT_DELETABLE", "涓嶈兘鍒犻櫎绠＄悊鍛樿处鍙?);
      }
      if (user.deleted_at) {
        return { ok: true, user };
      }
      const result = await client.query(
        `
        UPDATE users
        SET deleted_at = now(),
            deleted_by = 'admin',
            updated_at = now()
        WHERE id = $1
        RETURNING id, deleted_at, deleted_by
        `,
        [params.userId],
      );
      return { ok: true, user: result.rows[0] };

