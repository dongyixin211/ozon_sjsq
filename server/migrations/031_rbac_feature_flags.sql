-- 031_rbac_feature_flags.sql
-- RBAC: 角色扩展 + 功能标识 + 用户功能授权
-- 新增 beta 角色（测试用户），支持按功能粒度控制菜单可见性

-- ============================================================
-- 1. 扩展 users.role 约束：member -> member | beta | admin
-- ============================================================
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('member', 'beta', 'admin'));

-- ============================================================
-- 2. feature_flags: 功能标识表
--    每行代表一个可独立控制可见性的功能/菜单项
-- ============================================================
CREATE TABLE IF NOT EXISTS feature_flags (
  key           TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  module        TEXT NOT NULL,
  description   TEXT,
  default_roles TEXT[] NOT NULL DEFAULT '{}',
  is_active     BOOLEAN NOT NULL DEFAULT true,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_module
  ON feature_flags(module) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_feature_flags_active
  ON feature_flags(is_active, sort_order);

-- ============================================================
-- 3. user_feature_access: 用户个人功能授权（覆盖角色默认）
--    用于给特定 member 用户单独开通测试功能
-- ============================================================
CREATE TABLE IF NOT EXISTS user_feature_access (
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  feature_key  TEXT NOT NULL REFERENCES feature_flags(key) ON DELETE CASCADE,
  granted_by   UUID REFERENCES users(id),
  granted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ,
  revoked_at   TIMESTAMPTZ,
  PRIMARY KEY (user_id, feature_key)
);

CREATE INDEX IF NOT EXISTS idx_user_feature_access_user
  ON user_feature_access(user_id)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_user_feature_access_feature
  ON user_feature_access(feature_key)
  WHERE revoked_at IS NULL;

-- ============================================================
-- 4. 初始功能标识数据
--    对应前端 navigation.ts 中的 PageKey
-- ============================================================
INSERT INTO feature_flags (key, label, module, description, default_roles, sort_order) VALUES
  -- 素材模块 - 测试中功能
  ('gallery.upload',     '图片上传',     '素材', '批量上传图片到云存储',                   ARRAY['beta', 'admin'], 5),
  ('gallery.pending',    '待上传图片',   '素材', '查看和管理待上传的图片队列',             ARRAY['beta', 'admin'], 6),
  ('gallery.processing', '上传中',       '素材', '查看正在上传的图片进度',                 ARRAY['beta', 'admin'], 7),
  ('gallery.uploaded',   '已上传图片',   '素材', '查看已上传的图片库，支持筛选和搜索',     ARRAY['beta', 'admin'], 8),
  ('gallery.featured',   '精品图库',     '素材', '精选/置顶的图片管理',                    ARRAY['beta', 'admin'], 9),
  -- 上架模块 - 测试中功能
  ('listing.auto_plans', '自动上品方案', '上架', '自动上架方案配置与执行，含批次规划和选位', ARRAY['beta', 'admin'], 2),
  -- 管理后台 - 仅 admin 可见
  ('admin.panel',         '管理后台',     '管理', '用户角色与功能权限管理',                   ARRAY['admin'], 99)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 5. admin_audit_logs: 管理操作审计日志
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  admin_id        UUID REFERENCES users(id),
  action          VARCHAR(40) NOT NULL,
  target_user_id  UUID REFERENCES users(id),
  feature_key     VARCHAR(80),
  old_value       TEXT,
  new_value       TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created
  ON admin_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_target
  ON admin_audit_logs(target_user_id);

-- ============================================================
-- 5. updated_at 自动更新触发器 (feature_flags)
-- ============================================================
CREATE OR REPLACE FUNCTION update_feature_flags_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_feature_flags_updated_at ON feature_flags;
CREATE TRIGGER trg_feature_flags_updated_at
  BEFORE UPDATE ON feature_flags
  FOR EACH ROW
  EXECUTE FUNCTION update_feature_flags_updated_at();
