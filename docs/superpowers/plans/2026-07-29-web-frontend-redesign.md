# Ozon SJSQ 网页端视觉改造实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 只升级 Ozon SJSQ 网页端工作台的视觉系统与交互反馈，保持 Tauri 客户端状态页、业务逻辑、API 和本地助手流程不变。

**Architecture:** 网页构建仍从 `index.web.html` → `src/web-main.tsx` → `src/App.tsx` 进入；`App` 的非 Tauri 分支继续承载网页工作台，`isTauriRuntime()` 分支和 `LocalAssistantShell` 不改。视觉升级集中在 `src/styles.css` 的设计令牌、共享控件和网页工作台页面样式，必要时只给 `src/App.tsx` 增加语义 class 或可访问性属性。

**Tech Stack:** React 18、TypeScript、Vite、原生 CSS、`lucide-react`、Vitest、Testing Library。

## Global Constraints

- 只修改网页端工作台；Tauri 客户端状态页保持原样。
- 不引入 Tailwind、Ant Design、MUI、远程字体或额外动画库。
- 不修改 API 字段、业务流程、权限模型、Tauri Rust 代码和本地助手连接逻辑。
- 设计基准为 1440×900，信息密度为标准密度。
- 使用冷灰蓝色板、4px 间距体系、标准表格行高 48–54px。
- 每个任务完成后运行对应测试或构建检查；不做无关重构。

---

### Task 1: 建立网页端回归基线

**Files:**
- Inspect: `src/App.tsx:52-321`
- Inspect: `src/styles.css:1-220`, `src/styles.css:2450-2605`, `src/styles.css:3940-4040`
- Inspect: `vite.web.config.ts`
- Test: `src/features/dashboard/DashboardPage.test.tsx`, `src/features/auth/AuthGate.test.tsx`

**Interfaces:**
- Consumes: 当前网页入口和非 Tauri 分支。
- Produces: 明确的网页工作台验证命令与截图检查点，不改变代码行为。

- [ ] **Step 1: 确认网页入口和客户端边界**

  验证 `src/web-main.tsx` 引入的是 `App`，网页入口由 `src/App.tsx` 的非 Tauri 分支渲染；确认 `LocalAssistantShell` 只属于 Tauri 分支。

- [ ] **Step 2: 运行当前网页相关测试**

  Run: `npm test -- --run src/features/dashboard/DashboardPage.test.tsx src/features/auth/AuthGate.test.tsx`

  Expected: 当前基线测试通过；如果存在既有失败，只记录失败，不在本任务修复无关问题。

- [ ] **Step 3: 运行网页生产构建**

  Run: `npm run build:web`

  Expected: 构建产物生成到 `server/src/public/app`，无 TypeScript 或 Vite 构建错误。

- [ ] **Step 4: 记录基线截图检查点**

  使用网页入口验证登录门禁、工作台壳层、一个宽表格、一个弹窗和一个空/加载状态；客户端状态页不作为网页改造目标。

### Task 2: 重整网页端设计令牌与应用壳层

**Files:**
- Modify: `src/styles.css:1-220`
- Modify: `src/App.tsx:192-321`
- Test: `src/features/dashboard/DashboardPage.test.tsx`

**Interfaces:**
- Consumes: 当前 `.app-shell`、`.sidebar`、`.main`、`.topbar`、`.panel` 和导航 class。
- Produces: 保持现有 class API 的蓝灰令牌、网页侧边栏和页面标题层级。

- [ ] **Step 1: 替换全局令牌**

  在 `:root` 中集中定义字体、主色、背景、表面、文字、边框、圆角、阴影、焦点环和间距变量；正文使用系统字体栈，不添加网络字体。

- [ ] **Step 2: 升级网页壳层**

  调整 `.app-shell`、`.sidebar`、`.brand`、`.nav-item`、`.main` 和 `.topbar`：桌面保持左侧导航，当前项使用浅蓝底和深蓝文字，主内容在 1440px 下保留充分留白。

- [ ] **Step 3: 只给网页分支补语义 class**

  如果 `src/App.tsx` 当前结构无法区分网页与客户端样式，只在非 Tauri 渲染的壳层增加明确 class；不得修改 `LocalAssistantShell` 结构或样式选择器。

- [ ] **Step 4: 验证壳层行为**

  Run: `npm test -- --run src/features/dashboard/DashboardPage.test.tsx`

  Expected: 页面导航、页面切换和 Dashboard 渲染断言保持通过。

### Task 3: 统一网页端共享控件

**Files:**
- Modify: `src/styles.css:220-900`, `src/styles.css:3890-3935`
- Modify: `src/App.tsx:223-321`
- Modify: `src/features/auth/AuthGate.tsx`
- Test: `src/features/auth/AuthGate.test.tsx`

**Interfaces:**
- Consumes: 现有按钮、输入框、表单、标签、面板、表格包裹器、弹窗和消息 class。
- Produces: 所有网页页面共用的按钮、表单、面板、表格、状态和弹窗视觉规则。

- [ ] **Step 1: 先覆盖按钮和焦点状态**

  统一 `.primary-button`、`.secondary-button`、`.danger-button`、`.icon-button` 的高度、圆角、主次关系、悬停、禁用和 `:focus-visible`；保持现有 click handler 和 disabled 条件。

- [ ] **Step 2: 统一表单和登录门禁**

  调整 `.field`、`label`、`input`、`select`、`textarea`、`.tabs`、`.auth-shell` 和 `.auth-panel`，确保登录、注册、错误、加载和授权状态只改变呈现，不改变校验和提交逻辑。

- [ ] **Step 3: 统一面板、表格、标签和弹窗**

  统一 `.panel`、`.panel-header`、`.table-wrap`、`table`、`.badge`、`.status-pill`、`.modal-backdrop` 和 `.modal-panel`；标准表格行高控制在 48–54px，宽表格继续横向滚动。

- [ ] **Step 4: 补齐键盘和减少动效规则**

  为交互控件提供可见焦点环，并在 `@media (prefers-reduced-motion: reduce)` 下关闭旋转、过渡和非必要位移动画。

- [ ] **Step 5: 验证登录门禁**

  Run: `npm test -- --run src/features/auth/AuthGate.test.tsx`

  Expected: 登录、注册、加载、错误和授权门禁断言通过。

### Task 4: 按网页业务模块完成页面层视觉收口

**Files:**
- Modify: `src/features/dashboard/DashboardPage.tsx`
- Modify: `src/features/catalog/ProductCatalogPage.tsx`
- Modify: `src/features/materials/MaterialsPage.tsx`
- Modify: `src/features/orders/OrdersPage.tsx`
- Modify: `src/features/jobs/JobsPage.tsx`
- Modify: `src/features/cloud/CloudPage.tsx`
- Modify: `src/features/cloud/AutoListingPlansPage.tsx`
- Modify: `src/features/cloud/AutoListingTaskCenter.tsx`
- Modify: `src/features/cloud/GalleryManager.tsx`（只改网页可见 class 和局部样式接口）
- Modify: `src/styles.css` 对应页面命名空间段落
- Test: 各模块已有 `*.test.tsx` 文件

**Interfaces:**
- Consumes: Task 2 的网页壳层令牌和 Task 3 的共享控件。
- Produces: 业务页面统一的标题、筛选、表格、状态、空态、加载态、错误态和操作层级。

- [ ] **Step 1: 收口工作台**

  让 Dashboard 使用四列数据卡片、清晰标题区、增长商品面板和任务辅助面板；保留现有数据来源、导航回调和任务日志回调。

- [ ] **Step 2: 收口商品、订单和任务页**

  统一筛选工具栏、批量操作、表格状态、分页/滚动和危险操作反馈；不改变查询参数、分页逻辑和操作 API。

- [ ] **Step 3: 收口素材和云图库**

  统一上传工作台、图库列表、处理状态、批量选择、弹窗和空态；不重写 `GalleryManager` 的业务状态机，不删除现有本地处理和云端同步逻辑。

- [ ] **Step 4: 逐模块运行测试**

  Run: `npm test -- --run src/features/dashboard src/features/catalog src/features/orders src/features/jobs src/features/cloud`

  Expected: 现有模块测试通过；视觉 class 调整不改变业务断言。

### Task 5: 完成网页响应式与生产验证

**Files:**
- Modify: `src/styles.css` 响应式段落
- Test: `src/workspace/WorkspaceModuleTabs.test.tsx`, `src/workspace/navigation.test.ts`

**Interfaces:**
- Consumes: 全部网页端页面样式和共享控件。
- Produces: 1440px、1280px、900px、560px 下可用的网页工作台，以及可交付的网页构建产物。

- [ ] **Step 1: 验证桌面端**

  使用浏览器检查 1440×900 和 1280×720：侧边栏、标题栏、四列数据卡片、宽表格、弹窗和消息不遮挡。

- [ ] **Step 2: 验证窄屏端**

  使用 900px 和 560px 视口检查：壳层单列化、表单按钮换行、表格横向滚动、弹窗安全边距和键盘焦点。

- [ ] **Step 3: 运行完整测试**

  Run: `npm test`

  Expected: 全部已有 Vitest 测试通过。

- [ ] **Step 4: 构建网页产物**

  Run: `npm run build:web`

  Expected: 网页构建成功，产物写入 `server/src/public/app`；不运行或修改 Tauri 客户端构建流程。

- [ ] **Step 5: 检查网页 diff 边界**

  Run: `git diff -- src/App.tsx src/styles.css src/features src/workspace docs/superpowers`

  Expected: 修改只涉及网页端视觉、网页测试、网页设计文档和网页计划；不得出现 `src-tauri` 或客户端状态页的修改。
