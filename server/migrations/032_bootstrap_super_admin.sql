-- 032_bootstrap_super_admin.sql
-- 超级管理员初始化：将指定手机号的用户设为 admin 角色
-- 该用户登录时系统也会自动校验并补授 admin 角色（双重保障）

-- 将 18338062216 设为超级管理员（仅当用户存在时生效）
UPDATE users
SET role = 'admin',
    updated_at = now()
WHERE phone = '18338062216'
  AND role != 'admin';

-- 记录变更日志（如有受影响行，可由应用层打印）
DO $$
DECLARE
  affected_count INT;
BEGIN
  GET DIAGNOSTICS affected_count = ROW_COUNT;
  IF affected_count > 0 THEN
    RAISE NOTICE '032_bootstrap_super_admin: upgraded % user(s) to admin', affected_count;
  ELSE
    RAISE NOTICE '032_bootstrap_super_admin: no changes needed (user not found or already admin)';
  END IF;
END $$;
