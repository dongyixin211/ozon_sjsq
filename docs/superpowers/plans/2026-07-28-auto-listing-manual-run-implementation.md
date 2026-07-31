# 自动上品手动执行与调度注册 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增加方案级单次执行与进度入口，并修复本地调度器未注册导致进入执行时段仍不运行的问题。

**Architecture:** 扩展已有 `run_auto_listing_plan_now` 请求，使本地助手能区分强制执行和按时段调度。浏览器工作台在本地助手连接后执行一次非强制调度注册；方案卡片使用强制模式运行指定方案，并通过现有导航进入上传中任务中心。

**Tech Stack:** React、TypeScript、Vitest、Tauri、Rust、现有本地助手 HTTP 命令桥接。

## Global Constraints

- 不新增独立任务记录页面。
- 保持 Ozon 实时额度和图片唯一分配逻辑不变。
- 自动注册必须遵守方案执行时段。
- 手动执行只运行用户点击的方案并忽略执行时段。
- 修改范围仅限调度请求、页面入口、启动注册、测试和版本发布配置。

---

### Task 1: 调度请求区分强制与定时执行

**Files:**
- Modify: `src/lib/api.ts`
- Modify: `src-tauri/src/core/auto_listing_scheduler.rs`
- Test: `src-tauri/src/core/auto_listing_scheduler.rs`

**Interfaces:**
- Consumes: `RunAutoListingPlanNowRequest`
- Produces: 可选 `force` 字段；缺省保持强制执行兼容，自动注册显式传入 `false`

- [ ] **Step 1: Write the failing test**

增加 Rust 测试，证明非强制请求在执行时段外返回 `OutsideWindow`，强制请求使用全天窗口。

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test auto_listing_scheduler --manifest-path src-tauri/Cargo.toml`

- [ ] **Step 3: Write minimal implementation**

给 `RunSchedulerRequest` 增加缺省为 `true` 的 `force` 字段，并把命令传入的值交给 `tick_account`；TypeScript 请求类型同步增加 `force?: boolean`。

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test auto_listing_scheduler --manifest-path src-tauri/Cargo.toml`

### Task 2: 方案卡增加执行与进度入口

**Files:**
- Modify: `src/features/cloud/AutoListingPlansPage.tsx`
- Modify: `src/features/cloud/AutoListingPlansPage.test.tsx`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `api.runAutoListingPlanNow`、`cloudAccountId()`、`getCloudToken()`、`onNavigate('imageProcessing')`
- Produces: “立即执行一次”“查看进度”按钮及启动状态提示

- [ ] **Step 1: Write the failing tests**

增加页面测试：点击立即执行时传入当前方案 ID 和 `force: true`；执行期间按钮禁用；成功后跳转 `imageProcessing`；查看进度只跳转不调用执行接口。

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/features/cloud/AutoListingPlansPage.test.tsx`

- [ ] **Step 3: Write minimal implementation**

扩展页面 props 注入执行 API、连接状态、消息回调和导航回调，在方案卡内维护单个启动中的方案 ID。

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/features/cloud/AutoListingPlansPage.test.tsx`

### Task 3: 本地助手连接后注册自动调度

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/workspace/WorkspaceModuleTabs.test.tsx`

**Interfaces:**
- Consumes: 当前账号 ID、云端地址、云端令牌、本地助手连接状态
- Produces: 每次连接会话一次 `force: false` 的调度注册调用

- [ ] **Step 1: Write the failing test**

增加 App 测试，证明本地助手连接且已登录时调用 `runAutoListingPlanNow`，请求 `planId` 为空且 `force: false`；重复渲染不重复注册。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- src/workspace/WorkspaceModuleTabs.test.tsx`

- [ ] **Step 3: Write minimal implementation**

在 App 会话层增加一次性 effect；连接断开后允许下一次重新连接重新注册，失败只展示提示而不阻塞其他页面。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- src/workspace/WorkspaceModuleTabs.test.tsx`

### Task 4: 版本、全量验证与发布

**Files:**
- Modify: `package.json`
- Modify: `src-tauri/tauri.conf.json`
- Modify: `server/src/public/updates/latest.json`

**Interfaces:**
- Produces: 包含新调度语义的客户端更新和对应 Web 版本

- [ ] **Step 1: Update client version metadata**

将客户端补丁版本升级，并更新强制更新说明，确保旧客户端不会把自动注册误当成强制执行。

- [ ] **Step 2: Run focused and full verification**

Run: `npm test`

Run: `npm run build`

Run: `npm run build:web`

Run: `npm run check` in `server`

- [ ] **Step 3: Build signed client update**

使用项目现有客户端签名与更新发布流程生成安装包和 updater 文件。

- [ ] **Step 4: Deploy and verify production**

使用 `ozon-sjsq-deploy` 发布 Web/服务，验证健康接口、最新 Web 资源和客户端更新清单。
