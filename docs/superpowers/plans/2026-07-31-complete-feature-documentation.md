# Ozon SJSQ 全功能使用文档 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `docs/feature-guide/` 交付一套基于当前实现的中文全功能操作手册，覆盖本地工作台、云端工作区、商品上架闭环与套图技术原理。

**Architecture:** 文档按运营用户的工作流拆分为七个模块，由根导航页串联。每项可操作功能使用统一的“用途—前置条件—入口—步骤—系统处理—结果—异常”结构；功能真实性由页面组件、Tauri 命令、服务端路由及既有用户手册交叉核对。

**Tech Stack:** Markdown、React/TypeScript 前端、Tauri/Rust 本地服务、Fastify/Node.js 云服务、Vitest 测试用例（用于核对已实现行为）。

## Global Constraints

- 文档只描述当前代码或既有用户资料中可证实的功能，不推测未实现能力。
- 不记录 API Key、Cookie、许可证密钥、对象存储密钥或用户真实文件路径。
- 普通操作与管理员/运维能力分开标记。
- 套图必须明确为模板图像合成，不得表述成 AI 生图。
- 不修改应用逻辑、配置、测试或现有技术部署文档。

---

## 文件结构

| 文件 | 责任 |
| --- | --- |
| `docs/feature-guide/README.md` | 目录、角色、常用工作流和模块导航。 |
| `docs/feature-guide/01-项目与首次配置.md` | 环境、授权、店铺、Ozon、OSS、AI、目录与安全设置。 |
| `docs/feature-guide/02-素材处理与场景图.md` | 素材处理、AI 图文、本地场景套图、套图原理。 |
| `docs/feature-guide/03-商品上架全流程.md` | Excel/图片/模板准备到导入、自动后处理、结果验收和重试。 |
| `docs/feature-guide/04-商品运营与维护.md` | 已上架商品、库存、价格、活动、合并卡、跟卖和诊断。 |
| `docs/feature-guide/05-订单处理.md` | 查询、筛选、订单文件、下载目录与异常恢复。 |
| `docs/feature-guide/06-云图库与自动上架.md` | 云端图库、云端样机套图、店铺配置、计划、排程、任务和配额。 |
| `docs/feature-guide/07-任务、故障排查与管理员功能.md` | 任务、诊断、FAQ、管理员能力和技术文档入口。 |

### Task 1: 建立导航和配置文档

**Files:**
- Create: `docs/feature-guide/README.md`
- Create: `docs/feature-guide/01-项目与首次配置.md`
- Reference: `src/App.tsx`, `src/workspace/navigation.ts`, `src/features/settings/SettingsPage.tsx`, `src/features/auth/AuthGate.tsx`, `docs/user-manual.md`

**Interfaces:**
- Consumes: 当前应用导航、设置字段和授权行为。
- Produces: 所有后续章节引用的统一术语、功能入口和首次配置前置条件。

- [ ] **Step 1: 提取导航与设置功能**

Run: `rg -n "SettingsPage|AuthGate|nav|workspace" src/App.tsx src/workspace/navigation.ts src/features/settings/SettingsPage.tsx src/features/auth/AuthGate.tsx`

Expected: 输出页面名称、设置项与授权入口，且不以 README 作为唯一依据。

- [ ] **Step 2: 写入导航页和首次配置页**

Create the two Markdown files. Include user roles, document links, recommended onboarding order, shop/Ozon/OSS/AI/default-directory requirements, and security cautions.

- [ ] **Step 3: 核对链接和术语**

Run: `rg -n "\]\(" docs/feature-guide/README.md docs/feature-guide/01-项目与首次配置.md`

Expected: 每个模块链接使用真实文件名；页面术语与前端一致。

### Task 2: 编写素材、场景图与套图文档

**Files:**
- Create: `docs/feature-guide/02-素材处理与场景图.md`
- Reference: `src/features/materials/MaterialsPage.tsx`, `src/features/scene/ScenePage.tsx`, `src/lib/localMockupRenderer.ts`, `src-tauri/src/core/local_mockup.rs`, `server/src/mockup-renderer.ts`

**Interfaces:**
- Consumes: 首次配置中定义的 AI Provider、目录和权限要求。
- Produces: 可直接用于商品上架的规范图片与套图结果说明。

- [ ] **Step 1: 核对素材与场景图动作**

Run: `rg -n "3:4|水印|GPT|标题|重命名|场景|模板|开始生成" src/features/materials/MaterialsPage.tsx src/features/scene/ScenePage.tsx`

Expected: 输出全部用户可见操作入口、输入目录和任务启动动作。

- [ ] **Step 2: 核对套图实现边界**

Run: `rg -n "browser-canvas|perspective|uvMap|mask|blendMode|sharp|image::" src/lib/localMockupRenderer.ts server/src/mockup-renderer.ts src-tauri/src/core/local_mockup.rs`

Expected: 证明套图为模板图层合成，并识别浏览器、云端和本地助手渲染实现。

- [ ] **Step 3: 撰写素材与套图章节**

Document each operation with purpose, setup, entry, numbered actions, artifacts, task status, failure recovery, plus separate local-scene and cloud-mockup workflows and the technology-principle section.

- [ ] **Step 4: 核对非 AI 表述**

Run: `rg -n "套图|AI" docs/feature-guide/02-素材处理与场景图.md`

Expected: 套图相关段落明确写为模板合成；仅 AI 图片/文案功能写为 AI 生成。

### Task 3: 编写新品上架与商品运维文档

**Files:**
- Create: `docs/feature-guide/03-商品上架全流程.md`
- Create: `docs/feature-guide/04-商品运营与维护.md`
- Reference: `src/features/ozon/OzonPage.tsx`, `src-tauri/src/core/batch.rs`, `src-tauri/src/core/auto_listing.rs`, `src-tauri/src/core/listing_maintenance.rs`, `docs/user-manual.md`

**Interfaces:**
- Consumes: 店铺、API、OSS、图片、Excel 和商品模板准备结果。
- Produces: 从新品导入到验收的完整上架闭环，以及后续维护操作指引。

- [ ] **Step 1: 提取上架流程与用户界面字段**

Run: `rg -n "发布新品|商品模板|上架后自动处理|batch_upload_results|库存|条码|活动|更新商品" src/features/ozon/OzonPage.tsx src-tauri/src/core/batch.rs src-tauri/src/core/auto_listing.rs`

Expected: 覆盖 Excel、图片、模板、导入、任务、条码、库存、活动和结果文件。

- [ ] **Step 2: 写入商品上架全流程**

Explain preparation, each form selection, task submission, progress lookup, optional post-listing operations, output Excel verification, per-failure remediation, and rerun decision points.

- [ ] **Step 3: 写入日常运营章节**

Document product update, warehouse/inventory, price, promotion actions, viewing analytics, card merge, follow sync, and API diagnostics with their prerequisites and output states.

- [ ] **Step 4: 对照现有手册防止功能遗漏**

Run: `rg -n "^### 7\." docs/user-manual.md; rg -n "^##|^###" docs/feature-guide/03-商品上架全流程.md docs/feature-guide/04-商品运营与维护.md`

Expected: `docs/user-manual.md` 的上架运维小节均有新文档归属。

### Task 4: 编写订单与云端自动上架文档

**Files:**
- Create: `docs/feature-guide/05-订单处理.md`
- Create: `docs/feature-guide/06-云图库与自动上架.md`
- Reference: `src/features/orders/OrdersPage.tsx`, `src/features/cloud/GalleryManager.tsx`, `src/features/cloud/AutoListingPlansPage.tsx`, `src/features/cloud/AutoListingTaskCenter.tsx`, `server/src/routes/order-routes.ts`, `server/src/routes/gallery-routes.ts`, `server/src/routes/gallery-auto-listing-routes.ts`

**Interfaces:**
- Consumes: 已配置店铺、云端授权、图库素材、样机模板与商品模板。
- Produces: 订单文件和自动上架任务的完整业务操作说明。

- [ ] **Step 1: 提取订单查询与下载路径**

Run: `rg -n "订单|FBS|FBO|下载|PDF|目录" src/features/orders/OrdersPage.tsx server/src/routes/order-routes.ts`

Expected: 覆盖跨店查询、勾选下载、面单、拣货单与失败原因。

- [ ] **Step 2: 提取云端图库和自动上架行为**

Run: `rg -n "图库|样机|套图|计划|排程|配额|任务|暂停|恢复" src/features/cloud/GalleryManager.tsx src/features/cloud/AutoListingPlansPage.tsx src/features/cloud/AutoListingTaskCenter.tsx`

Expected: 覆盖素材生命周期、模板选择、计划条件、执行状态和恢复操作。

- [ ] **Step 3: 撰写两个模块文档**

Write independently runnable order and cloud workflows. State how cloud mockup results relate to original assets and how plans select assets without recycling result images as source assets.

- [ ] **Step 4: 核对异步状态说明**

Run: `rg -n "状态|任务|失败|重试|恢复" docs/feature-guide/05-订单处理.md docs/feature-guide/06-云图库与自动上架.md`

Expected: 每个异步功能说明状态查看位置和失败后下一步。

### Task 5: 编写任务、排障与管理员文档

**Files:**
- Create: `docs/feature-guide/07-任务、故障排查与管理员功能.md`
- Reference: `src/features/jobs/JobsPage.tsx`, `src/features/cloud/LicensePage.tsx`, `server/src/routes/admin-routes.ts`, `docs/cloud-admin-console.md`, `docs/cloud-api-reference.md`, `docs/aliyun-deploy-runbook.md`

**Interfaces:**
- Consumes: 前述模块产生的任务、结果、错误信息与角色限制。
- Produces: 用户可自助检查的问题清单和管理员技术资料入口。

- [ ] **Step 1: 提取任务和管理员边界**

Run: `rg -n "任务|日志|许可证|管理员|admin" src/features/jobs/JobsPage.tsx src/features/cloud/LicensePage.tsx server/src/routes/admin-routes.ts`

Expected: 清楚区分运营用户可见任务与管理员专属动作。

- [ ] **Step 2: 撰写排障与管理员章节**

Write task reading, diagnostics, feature-specific failure matrix, security guidance, and links to existing deployment/API/admin references without duplicating their implementation procedures.

- [ ] **Step 3: 核对链接目标**

Run: `Test-Path docs/cloud-admin-console.md; Test-Path docs/cloud-api-reference.md; Test-Path docs/aliyun-deploy-runbook.md`

Expected: 三个技术资料链接目标均存在。

### Task 6: 执行全量覆盖审查

**Files:**
- Modify: `docs/feature-guide/*.md`
- Reference: `src/workspace/navigation.ts`, `src/App.tsx`, `docs/user-manual.md`, `docs/ozon-operation-guide.md`

**Interfaces:**
- Consumes: 前五项产生的完整文档集。
- Produces: 可交付的交叉链接文档和功能覆盖审查结果。

- [ ] **Step 1: 对照导航和旧手册建立覆盖清单**

Run: `rg -n "label:|title:|path:" src/workspace/navigation.ts; rg -n "^##|^###" docs/user-manual.md docs/ozon-operation-guide.md`

Expected: 所有可见工作区与原有操作主题都有新文档归属。

- [ ] **Step 2: 检查文档链接与章节结构**

Run: `rg -n "^#|^##|\]\(" docs/feature-guide`

Expected: 根目录页能导航到全部七个模块，模块标题层级一致。

- [ ] **Step 3: 扫描禁止占位符和敏感信息**

Run: `rg -n -i "\b([T]BD|[T]ODO|api[_ -]?key\s*[:=]\s*[^<]|secret\s*[:=]\s*[^<]|cookie\s*[:=]\s*[^<])\b" docs/feature-guide`

Expected: 无待定占位符和实际凭证值；字段名称在必要时可作为配置说明出现。

- [ ] **Step 4: 人工审阅关键闭环**

Check that a new operator can follow: first configuration → material processing or mockup generation → product listing → task verification → maintenance or order fulfillment. Check that a cloud operator can follow: gallery upload → mockup → plan → task center → recovery.

- [ ] **Step 5: 记录验证结果**

Add a concise “验证范围” section to `docs/feature-guide/README.md` naming the source categories checked and any intentional boundary to technical documents.

