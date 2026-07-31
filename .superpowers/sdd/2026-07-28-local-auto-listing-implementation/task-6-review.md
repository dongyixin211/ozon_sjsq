# Task 6 Review: Automatic Listing Plan Wizard

## Verdict

NEEDS_CHANGES

## Findings

### [P1] 已保存方案没有编辑入口，保存链路始终只能新建

- 设计文档要求上架方案页面提供“编辑”，本次审查也明确要求检查保存/编辑行为。
- `src/features/cloud/AutoListingPlansPage.tsx:144` 只有 `startNewPlan`，`src/features/cloud/AutoListingPlansPage.tsx:409` 的方案列表只展示摘要，没有编辑按钮或将已有方案载入向导的行为。
- `src/features/cloud/autoListingUtils.ts:3` 的 draft 类型移除了 `id`，`src/features/cloud/AutoListingPlansPage.tsx:157` 因而永远以不带 `id` 的参数调用保存接口。
- `src/lib/cloudApi.ts:346` 和 `src/lib/cloudApi.ts:696` 已支持带 `id` 时走 PUT 更新；页面没有复用该能力。结果是用户保存后无法修改模板、店铺、时段、批次、缓冲或启用状态，只能继续创建新方案，并可能触发同商品类型启用方案冲突。
- 需要增加已有方案的编辑入口、保留方案 `id` 的编辑 draft、更新后替换列表项，并补充验证 PUT/编辑预填和保存结果的测试。

### [P1] 模板与运行配置检查只检查“ID 非空”，失效配置仍可保存为启用方案

- `src/features/cloud/autoListingUtils.ts:12` 仅判断 `productTemplateId` 和 `localTemplateId` 是否为空，不校验这些 ID 是否仍存在于已加载的商品模板/本地模板资源中，也不校验 `templateProduct` 快照是否有效。
- `src/features/cloud/AutoListingPlansPage.tsx:433` 会复用历史上架偏好；若偏好引用的模板已被删除，旧 ID 仍会进入 draft。`src/features/cloud/AutoListingPlansPage.tsx:397` 和 `src/features/cloud/AutoListingPlansPage.tsx:398` 又仅按 ID 是否非空显示“已配置”，最终 `savePlan` 会通过校验。
- 配置检查没有读取所选本地店铺的 `apiKeyStored`、`clientId`、`enabled`，因此缺少 Ozon 密钥或已停用的店铺也能保存到启用方案；设计要求检查店铺密钥。
- 仓库请求失败被 `src/features/cloud/AutoListingPlansPage.tsx:116` 吞掉并折叠为 `[]`，第 4 步仅显示“仓库未加载”，但 `src/features/cloud/autoListingUtils.ts:5` 的保存校验完全不检查仓库。缺少仓库的方案仍可保存为启用状态；设计要求检查仓库。
- 需要让配置检查基于当前资源验证模板真实存在、店铺已启用且密钥完整、所需仓库有效；至少对启用方案阻止保存，并补充失效模板、本地模板、密钥和仓库失败测试。

### [P2] 面向用户的云端错误未做中文化

- `src/features/cloud/AutoListingPlansPage.tsx:135` 和 `src/features/cloud/AutoListingPlansPage.tsx:164` 直接展示后端错误文本。
- 例如同商品类型已有启用方案时，服务端返回英文 `An enabled plan already exists for this product rule`，页面会原样显示，不符合本次要求的中文 UX。
- 建议至少映射自动上品方案相关错误码/已知消息为中文，并保留无法识别错误的安全兜底。

## Confirmed Correct

- 四步结构与顺序符合设计：商品类型与内容模板、目标店铺与商品模板、调度设置、配置检查。
- 复用了现有商品类型、样机、标题提示词、云端店铺、商品模板、上架偏好、本地模板和仓库接口，并复用了 `buildInitialListingSetup`；未把新逻辑塞入 `GalleryManager`。
- 新建保存路径可用，保存后列表替换同 ID 项并展示商品类型、样机、提示词、店铺和执行时段摘要。
- `batchSize` 校验为整数且范围 5–20，边界 5 和 20 有测试；`bufferSize` 限制为非负整数且不超过 `2 * batchSize`。
- 导航新增 `autoListingPlans`，位于“上架”模块；`App.tsx` 已导入并渲染页面。
- 主要页面文案、步骤标题、字段和校验消息为中文；未新增样式、调度器或 Task 7 功能等无关扩展。

## Verification

- `npm test -- src/features/cloud/AutoListingPlansPage.test.tsx src/workspace/navigation.test.ts`
  - 结果：2 个测试文件通过，10/10 tests passed。
- `npm run build`
  - 结果：失败，但仅命中 Task 7 并行修改 `src/features/cloud/GalleryManager.tsx`：
    - `5982`: `listingRunning` 不存在于 `CloudListingBatchProgressSummary`。
    - `5985`: `mockupRunning` 不存在于 `CloudListingBatchProgressSummary`。
    - `5985`: `titleRunning` 不存在于 `CloudListingBatchProgressSummary`。
  - 未报告 Task 6 文件的 TypeScript 错误。

## Scope Notes

- 根目录没有实体 `AGENTS.md`，审查按用户消息中提供的根 AGENTS 指令执行。
- 当前环境没有可用的 `git` 命令，无法用 git diff 独立确认提交边界；本次仅审查指定文件及其直接依赖，没有修改或回滚实现文件。
