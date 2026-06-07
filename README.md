# Ozon SJSQ

Ozon SJSQ 是一个单机桌面工作台，用来替代旧版 `ozon-tool` 的 Tkinter 单体工具。项目目标是结构清晰、支持 macOS/Windows、页面简约，并把高频 Ozon Seller API 接入到本地应用里。

## 功能范围

- AI 商品素材：商品图、3:4 转图、水印、标题/简介/卖点、Excel 汇总。
- 场景图：本地模板合成与 AI 场景图任务入口。
- Ozon 上架运维：商品查询、仓库查询、导入任务状态、批量上架、已上架更新、库存和条码流程。
- 本地数据：SQLite 保存店铺、设置、模板和任务记录。
- 敏感密钥：通过系统密钥库保存 Ozon Api-Key、OSS Secret 等信息。

## 项目结构

```text
src/                 React + TypeScript 前端
src-tauri/           Tauri/Rust 后端
packages/shared/     前后端共享类型和校验 schema
fixtures/            Ozon mock 响应和测试素材
tests/               端到端测试入口
```

## 本地开发

本项目已在 `.tooling/node` 准备了本地 Node.js/npm，用来避免 macOS 上 Codex 内嵌 Node 加载 Rollup 原生依赖时报签名错误。启动开发版：

```bash
./start-mac.command
```

或手动执行：

```bash
export PATH="$PWD/.tooling/node/bin:$PATH"
npm install
npm run tauri:dev
```

打包：

```bash
export PATH="$PWD/.tooling/node/bin:$PATH"
npm run tauri:build
```

macOS 目标为 `.dmg`，Windows 目标为 `.msi`。

## Ozon API

应用统一使用：

- Base URL: `https://api-seller.ozon.ru`
- Header: `Client-Id`
- Header: `Api-Key`

第一版封装的高频接口：

- `/v3/product/list`
- `/v3/product/info/list`
- `/v4/product/info/attributes`
- `/v3/product/import`
- `/v1/product/import/info`
- `/v2/warehouse/list`
- `/v4/product/info/stocks`
- `/v2/products/stocks`
- `/v1/barcode/generate`

API Key 获取入口：[seller.ozon.ru/app/settings/api-keys](https://seller.ozon.ru/app/settings/api-keys)

## 当前实现状态

已落地 Tauri/React 项目骨架、SQLite/密钥库/Ozon API/任务中心/Excel 模板、SKU 图片目录分析、商品 payload 构造、Aliyun OSS 签名上传、批量上架任务、已上架更新任务、3:4 图片转换、水印、本地场景图合成，以及 OpenAI 兼容 AI 图文 provider 调用。

批量上架流程：

1. 读取 Excel 的 `货号`、`标题`、`简介`、`json富文本内容`。
2. 按 `3:4 图片目录/货号` 匹配图片。
3. 上传图片到 OSS，生成公网 URL。
4. 基于商品模板构造 Ozon import item。
5. 提交 `/v3/product/import` 并在任务日志记录 `task_id`。
6. 在图片目录生成 `batch_upload_results.xlsx`，包含货号、标题、图片数量、状态、成功 SKU、task_id、OSS 文件夹和错误信息。

已上架更新流程：

1. 按货号读取线上商品详情和属性。
2. 按勾选项更新标题、简介、图片、视频、JSON 富内容。
3. 图片更新时重新上传 OSS；未勾选图片时保留线上图片 URL。
4. 提交 `/v3/product/import` 更新商品。
5. 在图片目录生成 `listed_update_results.xlsx`。

素材与场景图流程：

1. 素材页读取 SKU 文件夹下图片。
2. 可调用 OpenAI 兼容 `/images/edits` 用源图做参考生成 AI 商品图，编辑失败时自动回退 `/images/generations`。
3. 本地生成 1200 x 1600 的 3:4 图片，可叠加右下角水印。
4. 可调用 OpenAI 兼容 `/chat/completions` 生成标题、简介、卖点，输出 JSON/TXT。
5. 场景图页支持 `flat_full`、`headscarf_side`、`headscarf_back`、`bow_and_fold`、`size_chart` 等本地布局；配置模板目录后会优先读取 `<scene_id>.jpg/png`、`<scene_id>/base.jpg/png`、`<scene_id>/mockup.jpg/png` 等底图。
6. 生成结果按 `输出目录/货号` 保存。

仍待继续迁移的旧工具能力：

- 透视变形级别的 mockup 贴图和更精细字体绘制。
- Windows/macOS 实机打包验证。
