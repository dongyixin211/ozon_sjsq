# Ozon SJSQ 项目整合升级文档

> 版本：v2.0 | 日期：2026-08-08

本文档整合了后端架构重构、UI 设计系统、前端布局优化三份设计方案的实施记录，涵盖 RBAC 角色权限、设计令牌、管理后台页面三大模块。

---

## 一、升级总览

| 模块 | 变更范围 | 状态 |
|------|---------|------|
| 设计令牌系统 | 新建 `tokens.css`，统一 4 处冲突 `:root` | ✅ 已完成 |
| RBAC 后端 | 迁移、服务层、中间件、API 端点 | ✅ 已完成 |
| RBAC 前端 | Context、权限过滤、菜单守卫、管理页面 | ✅ 已完成 |
| 管理后台页面 | 用户管理、功能开关、操作日志 | ✅ 已完成 |
| 前端布局优化 | `layout-fix.css` 12 项修复 | ✅ 已完成 |
| 超级管理员机制 | `SUPER_ADMIN_PHONE` 自动授权 + 存量回填 | ✅ 已完成 |

---

## 二、RBAC 角色权限系统

### 2.1 角色定义

| 角色 | 标识 | 权限范围 |
|------|------|---------|
| 普通用户 | `member` | 仅基础功能（首页、素材基础、上架基础、订单、任务） |
| 内测用户 | `beta` | 基础功能 + 全部活跃测试功能 |
| 管理员 | `admin` | 全部功能（`["*"]`）+ 管理后台 |

### 2.2 数据库变更

**迁移文件**：
- `server/migrations/031_rbac_feature_flags.sql` — RBAC 基础表
- `server/migrations/032_bootstrap_super_admin.sql` — 超级管理员存量回填

新增三张表：

```sql
-- 功能标识表：定义所有可控功能
CREATE TABLE feature_flags (
  key VARCHAR(80) PRIMARY KEY,        -- 如 gallery.upload
  label VARCHAR(120) NOT NULL,
  module VARCHAR(60) NOT NULL,         -- gallery / listing / admin
  description TEXT,
  default_roles TEXT[] DEFAULT '{}',   -- 默认可见角色
  is_active BOOLEAN DEFAULT true,
  sort_order INT DEFAULT 0
);

-- 用户个人功能授权表
CREATE TABLE user_feature_access (
  user_id UUID REFERENCES users(id),
  feature_key VARCHAR(80) REFERENCES feature_flags(key),
  granted_by UUID REFERENCES users(id),
  granted_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  PRIMARY KEY (user_id, feature_key)
);

-- 管理操作审计日志
CREATE TABLE admin_audit_logs (
  id UUID PRIMARY KEY,
  admin_id UUID REFERENCES users(id),
  action VARCHAR(40),              -- role_change / feature_grant / feature_revoke
  target_user_id UUID,
  feature_key VARCHAR(80),
  old_value TEXT,
  new_value TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
```

初始功能标识数据：

| key | label | module | default_roles |
|-----|-------|--------|--------------|
| gallery.upload | 图片上传 | gallery | [beta, admin] |
| gallery.pending | 待上传图片 | gallery | [beta, admin] |
| gallery.processing | 上传中 | gallery | [beta, admin] |
| gallery.uploaded | 已上传图片 | gallery | [beta, admin] |
| gallery.featured | 精品图库 | gallery | [beta, admin] |
| listing.auto_plans | 自动上品方案 | listing | [beta, admin] |
| admin.panel | 管理后台 | admin | [admin] |

### 2.3 后端架构

```
请求流：
  Bearer Token → requireAuth → requireAdminRole → RBAC 端点
                                              ↘ requireFeature → 业务端点
```

**新增文件**：

| 文件 | 职责 |
|------|------|
| `server/src/feature-service.ts` | 功能标识缓存（60s TTL）、`computeUserFeatures()`、`hasFeatureAccess()` |
| `server/src/feature-middleware.ts` | `requireFeature(key)` Fastify preHandler |

**修改文件**：

| 文件 | 变更 |
|------|------|
| `server/src/auth.ts` | `CurrentUser.role` 增加 `"beta"`；新增 `requireAdminRole()` |
| `server/src/routes/auth-routes.ts` | `/me` 端点返回 `features: string[]` |
| `server/src/routes/admin-routes.ts` | 7 个 RBAC 端点使用 `requireAdminRole`（非 `requireAdminToken`） |

**RBAC API 端点**（用户 Bearer token + admin 角色鉴权）：

| 方法 | 路径 | 功能 |
|------|------|------|
| GET | `/admin/features` | 列出所有功能标识 |
| PUT | `/admin/features/:featureKey` | 修改 default_roles 或 is_active |
| PUT | `/admin/users/:userId/role` | 修改用户角色 |
| GET | `/admin/users/:userId/features` | 查看用户功能授权 |
| POST | `/admin/users/:userId/features` | 授予功能权限 |
| DELETE | `/admin/users/:userId/features/:featureKey` | 撤销功能权限 |
| GET | `/admin/audit-logs` | 查看操作审计日志 |

### 2.4 前端架构

```
登录验证：
  AuthGate → client.me() → { user, features }
           → FeaturesProvider (React Context)

菜单过滤：
  useFeatures() → filterModulesByFeatures(modules, features)
                → 仅渲染有权限的模块和页面

路由守卫：
  useEffect → canAccessPage(features, page)
            → 无权限时自动跳转 dashboard

标签页过滤：
  WorkspaceModuleTabs → canAccessPage() 过滤可见 tab
```

**新增文件**：

| 文件 | 职责 |
|------|------|
| `src/workspace/featurePermissions.ts` | `PAGE_FEATURE_MAP`、`hasFeature()`、`canAccessPage()`、`filterModulesByFeatures()` |
| `src/lib/featuresContext.tsx` | `FeaturesProvider` + `useFeatures()` React Context |
| `src/features/admin/AdminUsersPage.tsx` | 用户管理页面（列表、角色切换、功能授权抽屉） |
| `src/features/admin/AdminFeaturesPage.tsx` | 功能开关页面（角色勾选、上下线切换） |
| `src/features/admin/AdminLogsPage.tsx` | 操作日志页面（分页、筛选） |

**修改文件**：

| 文件 | 变更 |
|------|------|
| `packages/shared/src/types.ts` | `CloudUser` 增加 `role: "member" \| "beta" \| "admin"` 和 `features?: string[]` |
| `src/workspace/navigation.ts` | `PageKey` 增加 `adminUsers`/`adminFeatures`/`adminLogs` |
| `src/lib/cloudApi.ts` | `me()` 返回 `features`；新增 8 个 admin API 方法 |
| `src/features/auth/AuthGate.tsx` | 存储 features，包裹 `FeaturesProvider` |
| `src/App.tsx` | 使用 `useFeatures()` + `visibleModules` + 路由守卫 + admin 页面路由 |
| `src/workspace/WorkspaceModuleTabs.tsx` | 按 `canAccessPage()` 过滤标签页 |

---

## 三、设计令牌系统

### 3.1 令牌文件

**新建**：`src/styles/tokens.css`

作为全部设计变量的唯一数据源，在 `main.tsx` 和 `web-main.tsx` 中于 `styles.css` 之前加载。

```css
:root {
  /* 颜色 */
  --color-primary: #1677ff;
  --color-primary-hover: #4096ff;
  --color-success: #52c41a;
  --color-warning: #faad14;
  --color-danger: #ff4d4f;

  /* 字号 */
  --fs-body: 14px;
  --fs-sm: 12px;
  --fs-lg: 16px;
  --fs-xl: 20px;
  --fs-2xl: 24px;

  /* 间距 */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;

  /* 圆角 */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;

  /* 阴影 */
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.05);
  --shadow-md: 0 4px 6px rgba(0,0,0,0.07);

  /* 过渡 */
  --transition-fast: 150ms ease;
  --transition-normal: 250ms ease;
}
```

### 3.2 布局优化

`src/styles/layout-fix.css`（380 行）在 `styles.css` 之后加载，零破坏性地修复 12 项布局问题：

1. 侧边栏固定宽度，主内容区自适应
2. 顶栏 sticky 定位
3. 标签页横向滚动
4. 表单网格响应式
5. 表格溢出滚动
6. 按钮组对齐
7. 卡片间距统一
8. 移动端侧边栏折叠
9. 数据表格行高优化
10. 模态框层级修正
11. 状态标签颜色统一
12. 暗色主题适配

---

## 四、管理后台页面

### 4.1 用户管理（AdminUsersPage）

- 用户列表：分页、搜索（手机号/昵称）、会员状态筛选
- 角色切换：下拉框直接修改用户角色（member/beta/admin）
- 功能授权抽屉：查看用户已授权功能、授予新功能、撤销功能

### 4.2 功能开关（AdminFeaturesPage）

- 按模块分组展示所有功能标识
- 角色勾选：点击 Toggle 切换某角色是否默认可见该功能
- 上下线切换：一键启用/禁用功能标识
- 变更立即生效（后端 60s 缓存自动失效）

### 4.3 操作日志（AdminLogsPage）

- 审计日志列表：分页、按操作类型筛选
- 记录所有角色变更、功能授予/撤销操作
- 显示操作人、目标用户、功能标识、变更内容

---

## 五、部署清单

### 5.1 数据库迁移

```bash
# 执行 RBAC 迁移
psql -f server/migrations/031_rbac_feature_flags.sql
# 超级管理员存量回填（将 18338062216 设为 admin）
psql -f server/migrations/032_bootstrap_super_admin.sql
```

### 5.2 环境变量

新增 `SUPER_ADMIN_PHONE`（默认 `18338062216`）：

```env
# 超级管理员手机号 — 该账号注册/登录时自动获得 admin 角色
# admin 角色用户可以访问管理后台，管理其他用户的角色和功能权限
SUPER_ADMIN_PHONE=18338062216
```

`requireAdminRole` 使用用户 Bearer token 鉴权，不依赖 `ADMIN_TOKEN`。
`ADMIN_TOKEN` 仅保留用于旧 `/admin` 页面（license key 管理等传统功能）。

### 5.3 超级管理员工作机制

1. **注册时**：手机号匹配 `SUPER_ADMIN_PHONE` 的用户自动获得 `admin` 角色
2. **登录时**：存量用户若手机号匹配但角色不是 admin，自动升级（双重保障）
3. **管理后台**：admin 角色用户可在「管理后台 → 用户管理」中给其他用户分配 admin/beta/member 角色
4. **权限传递**：超级管理员可以"任命"更多管理员，不需要修改环境变量

### 5.4 前端构建

```bash
npm run build
```

### 5.5 后端部署

```bash
cd server && npm run build && npm start
```

---

## 六、后续待办

| 项目 | 说明 | 优先级 |
|------|------|--------|
| styles.css `:root` 冲突清理 | 3 个重复 `:root` 块已移除，tokens.css 成为唯一来源 | ✅ 已完成 |
| 后端模块骨架 | core/modules/infrastructure 目录分层已创建 | ✅ 已完成 |
| UI 组件库 | Button/Input/Card/Badge/Alert 基础组件已抽取 | ✅ 已完成 |
| 后端架构重构 Phase 2-4 | 模块拆分、任务队列、可观测性 | 中 |
| layout-fix.css 清理 | 将修复合并到 styles.css 主文件 | 低 |
| 功能权限批量操作 | 批量授予/撤销多用户功能 | 低 |
| 功能权限过期提醒 | 即将过期的授权自动通知 | 低 |
