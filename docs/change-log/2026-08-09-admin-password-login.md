# 2026-08-09 管理员密码登录与本地测试规范

## 目的

- 管理后台不再使用浏览器保存的静态管理员口令。
- 管理员通过独立的手机号和密码登录，后台接口只接受管理员会话 JWT。
- 本地测试运行工作区最新源码；正式环境只从已提交的 `main` 版本构建发布。

## 数据库变更

1. 执行 `server/migrations/031_rbac_feature_flags.sql`：角色、功能开关、个人授权、操作审计。
2. 执行 `server/migrations/032_bootstrap_super_admin.sql`：将 `18338062216` 对应用户升级为 `admin`。
3. 执行 `server/migrations/032_admin_console_lifecycle.sql`：补齐管理端软删除字段与索引。
4. 执行 `server/migrations/039_admin_password_login.sql`：创建独立管理员账户与可撤销会话表。
5. 用 `ADMIN_BOOTSTRAP_PHONE` 与 `ADMIN_BOOTSTRAP_PASSWORD` 临时环境变量运行 `npm run admin:bootstrap`；密码只生成 bcrypt 哈希，不写入仓库、迁移或日志。

## 验证步骤

1. `cd server; npm run migrate`。
2. 初始化管理员账号后，访问 `/admin`，使用手机号和密码登录。
3. 确认 `/admin/users` 返回用户数据；未登录或普通用户令牌请求必须返回 401/403。
4. 运行 `npm run check`、`npm test`，并运行根目录的 `npm run dev` 验证最新前端源码。

## 发布与本地规则

- **本地测试**：允许未提交代码；启动 Vite 和 `server/src/index.ts` 源码服务；仅在本地测试库执行待测迁移。
- **正式发布**：先提交并确认 `main`；从该提交构建，部署相同提交中的迁移；禁止直接发布工作区未提交内容。
- **留档**：每次功能调整在 `docs/change-log/` 新增记录，注明目的、涉及文件/迁移、验证结果、发布提交和回退方式。

## 已知注意事项

- 当前迁移文件存在重复编号 `031` 与 `032`。现有迁移脚本按文件名排序且不记录执行历史，执行前应先备份测试库；后续新增迁移必须使用唯一递增编号。


## 管理后台导航与权限入口调整

- 原因：旧静态管理控制台没有接入已有的角色、功能开关、操作日志接口，且左侧菜单长期全部展开。
- 修改：`server/src/public/admin.html` 增加“权限管理”分组，包含“用户角色 / 功能开关 / 操作日志”三个页面。
- 修改：左侧菜单改为分组折叠；初始全部收起，当前路由所属分组自动展开，点击分组标题可展开或收起。
- 用户角色：通过 `PUT /admin/users/:userId/role` 更新 `member / beta / admin`。
- 功能开关：通过 `PUT /admin/features/:featureKey` 更新默认角色。
- 操作日志：通过 `GET /admin/audit-logs` 查看角色和功能授权的审计记录。
- 验证：后端测试 52/52 通过，`npm run check` 通过，后端构建通过；RBAC API 返回 6 个用户和 7 个功能。

## 多角色与管理员会话恢复修复

- 问题：保存角色后审计日志仍读取已不存在的 `request.currentUser.id`，导致角色已写入但接口报错。
- 修复：审计日志改为使用独立管理员会话的 `request.currentAdmin?.userId ?? null`。
- 数据模型：新增 `server/migrations/040_user_roles.sql` 和 `user_roles` 表；一个用户可同时拥有 `member`、`beta`、`admin` 多个角色，`users.role` 保留为旧代码兼容的主角色。
- 权限计算：角色默认权限按全部角色取并集，任一 `admin` 角色拥有全部权限，个人授权保持有效。
- 管理界面：用户角色改为多选复选框，保存请求发送 `roles[]`，至少选择一个角色。
- 会话恢复：新增 `GET /admin/auth/session`；刷新时校验本地会话，校验成功直接进入后台，只有会话失效时才显示登录页。
- 数据修复：本地测试库已将 `18338062216` 修复为 `admin`，角色集合为 `admin`。
- 验证：角色多选保存与还原、会话校验均返回 HTTP 200；后端测试 53/53 通过，类型检查与生产构建通过。

## 管理员权限页紧凑化与中文化

- 问题：角色复选框受通用标签样式影响纵向撑开；用户列表未展示多角色；功能开关使用了接口中不存在的英文/空字段。
- 修改：`server/src/public/admin.html` 改用紧凑中文角色标签，支持同一用户和功能选择多个角色；用户列表新增“角色”列，显示完整角色集合。
- 功能开关：页面改用接口实际返回的 `label`、`module` 与 `description`；技术 `key` 仅保留为辅助小字。
- 保护：拥有 `admin` 角色的用户继续禁止删除，按多角色集合判断。
- 验证：`node --import tsx --test src/admin-auth.test.ts`、`npm run check`、`npm test`（54/54）和 `npm run build` 均通过。


## 管理后台角色数据加载中断修复

- 现象：进入“用户角色”后表格表头可见，但一直显示“正在加载用户角色”，用户数据未渲染。
- 根因：页面启动时先执行 `showPage(routePage())`，其内部依赖的 `pageGroup` 使用 `const` 声明但尚未初始化，浏览器抛出 `ReferenceError`，会话恢复与页面数据请求被中断。
- 修复：将 `pageGroup` 导航元数据移动到首次 `showPage()` 调用之前；角色页成功加载后更新状态为“用户角色已刷新”。
- 验证：真实管理员会话请求 `/admin/users?limit=100&offset=0` 返回 6 条用户，Edge 页面实际渲染 6 行且无脚本异常；`node --import tsx --test src/admin-auth.test.ts`（7/7）和 `npm run check` 通过。
## 多角色保存后回读缺失修复

- 现象：`18338062216` 同时选择“测试用户”和“管理员”并保存后，页面刷新只显示“管理员”。
- 根因：`PUT /admin/users/:userId/role` 已正确写入 `user_roles`，但 `GET /admin/users` 只返回旧主角色 `users.role`；该字段按优先级保留 `admin`，页面回读时看不到 `beta`。
- 修复：用户列表查询聚合 `user_roles` 并返回 `roles` 数组，同时保留旧 `role` 字段兼容现有功能。
- 验证：本地真实接口对 `18338062216` 返回 `roles: ["admin", "beta"]`；Edge 刷新角色页后“测试用户”和“管理员”均保持选中；`npm run check`、`npm test`（57/57）及 `npm run build` 均通过。
## 2026-08-09 正式环境发布

- 发布范围：当前 `main` 工作区中已通过本地构建与测试的管理员密码登录、角色权限、多角色回读、用户端功能菜单权限及管理页 UI 更新。
- 本地校验：桌面构建、网页版构建、前端测试（22 个测试文件，130 通过，1 跳过）、服务端类型检查均通过。
- 发布动作：上传至正式服务器 `/opt/ozon-sjsq-cloud`，远程执行构建、迁移并重启 `ozon-sjsq-cloud` 服务。
- 线上验证：`https://api.dyxtoolai.cn/health` 返回 `ok: true`；线上入口引用 `/app/assets/index.web-DKs6C_sm.js`，静态资源包含 `gallery.upload`、`imageUpload` 和 `adminUsers` 权限菜单标识。
- 注意：本次按用户要求发布当前工作区，工作区仍有未提交修改；后续正式发布前建议先提交并固定发布提交点。
## 正式环境管理员密码重置

- 时间：2026-08-09。
- 操作：重置正式环境 `18338062216` 的独立管理端账号密码，并重新启用该管理员账号。
- 验证：正式环境 `POST /admin/auth/login` 返回 HTTP 200，登录成功。
- 安全：明文密码未写入仓库、变更记录或命令输出。
## 2026-08-09 GPT 图片生成菜单权限调整

- 需求：用户端“GPT 图片生成”仅对测试用户显示，普通用户不显示，管理员保持可见。
- 实现：新增独立功能标识 `ai.image_generation`，避免与 `gallery.upload` 图片上传权限耦合。
- 前端：将 `materialAiImage` 映射到 `ai.image_generation`，菜单按用户 `features` 自动过滤。
- 数据库：新增 `server/migrations/041_ai_image_generation_feature.sql`，默认角色为 `beta`（测试用户）和 `admin`。
- 验证：前端权限测试 4/4 通过，服务端测试 57/57 通过，前端构建、网页版构建和服务端类型检查通过。
- 发布：本次只更新本地工作区，未发布正式环境；正式环境需在提交后按发布流程执行迁移和构建。