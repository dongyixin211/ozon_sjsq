# 前端排版与管理端优化方案

> 文档生成日期: 2026-08-08
> 分析范围: `src/styles.css` (6493 行) + 12 个页面组件 + 布局组件
> 优化策略: 零破坏性覆盖层，不改动原文件

---

## 一、问题诊断总览

### 1.1 问题统计

| 问题类别 | 严重度 | 影响范围 | 根因 |
|---------|--------|---------|------|
| CSS 变量 4 次重定义 | P0 | 全局 | `:root` 出现在行 1、4049、5280，值各不相同 |
| 字号 17 种零散值 | P1 | 全局 | 无设计令牌，h3=13px 与正文同号 |
| 间距 3 种写法混用 | P1 | 全局 | 硬编码 px / calc() / CSS 变量混搭 |
| 表格固定 min-width | P1 | 7+ 个表格 | 1120-1380px 固定宽度，窄屏无法使用 |
| 200+ 硬编码色值 | P2 | 全局 | CSS 变量定义了但不用，直接写色值 |
| 6 处 !important | P2 | 6 个选择器 | 特异性冲突的 hack |
| 4 个冲突 @media(900px) | P2 | 响应式 | 前 3 个块被第 4 个覆盖，是死代码 |
| 字体声明但未加载 | P2 | 全局 | Inter / Segoe UI 声明了但没有 @font-face |
| 无骨架屏/统一空状态 | P3 | 用户体验 | 各页面自行处理加载和空态 |

### 1.2 核心问题详解

#### 问题 1: `:root` 四次重定义

```
行 1:     --color-primary: #1677ff;  --color-bg: #f3f5f9;  font-size: 13px;
行 4049:  --color-primary: #2563eb;  --color-bg: #f4f7fb;  新增 --space-1~8
行 5280:  --color-primary: #2563eb;  --color-bg: #eef3f8;  font: "Segoe UI Variable"
```

CSS 层叠规则：后面的 `:root` 完全覆盖前面的。最终生效的是第 3 块（行 5280），前两块的变量值全部是死代码。更严重的是，大量后续 CSS 规则使用了**硬编码值**而非 `var()` 引用，导致变量形同虚设。

#### 问题 2: 字号层级缺失

原文件存在 17 种不同字号：11px, 12px, 13px, 14px, 15px, 16px, 17px, 18px, 20px, 21px, 22px, 24px, 26px, 28px, 30px, 38px, 48px。

- `h1` 被覆盖 5 次：22px → 20px → 21px → 26px → 30px
- `h2` 被覆盖 3 次：16px → 17px → 20px → 24px
- `h3` = 13px = 正文字号，**无法区分层级**
- 基础字号 13px 对中文密集管理界面偏小

#### 问题 3: 间距系统混乱

三种写法并存：
- **硬编码像素** (大部分): `padding: 14px; gap: 10px; margin: 12px;`
- **CSS 计算值**: `calc(100vh - 92px)`
- **CSS 变量** (仅后半部分): `var(--space-3)` = 12px

`.panel` 的 padding 被覆盖 3 次：行 226 设为 14px → 行 4199 覆盖为 18px → 行 5493 覆盖为 20px。

#### 问题 4: 表格固定 min-width

| 选择器 | min-width | 行号 |
|--------|-----------|------|
| `.gallery-list-table` | 1120px | 2281 |
| `.pending-list-table` | 980px / 1380px | 2284 / 4954 |
| `.processing-list-table` | 1240px / 1280px | 2287 / 4958 |
| `.order-table` | 1280px | 3630 |
| `.shop-table` | 980px | 3799 |
| `table` | 600px | 805 |
| `.dashboard-store-table-wrap table` | 920px | 5880 |

在 900px 断点以下，侧边栏已折叠为顶部横向导航，但表格仍保持 1000px+ 的最小宽度，用户只能横向拖拽查看。

---

## 二、优化方案

### 2.1 策略：覆盖层而非重写

创建 `src/layout-fix.css`，在 `styles.css` 之后引入。利用 CSS 层叠优先级，覆盖冲突值，**不改动原 6493 行文件**。

**优势**：
- 零破坏性 — 原文件不动，出问题随时移除覆盖文件
- 渐进增强 — 后续可以逐步将原文件中的硬编码值迁移到变量
- 即时生效 — 只需在 `main.tsx` 和 `web-main.tsx` 各加一行 import

### 2.2 已实施的 12 项优化

#### 1. 统一设计令牌 (P0)

```css
:root {
  --color-primary: #2563eb;
  --color-text: #1a2332;
  --color-text-heading: #0f172a;
  --color-muted: #64748b;
  --color-border: #e2e8f0;
  --color-bg: #eef2f7;
  --color-surface: #ffffff;
  /* ... 语义色、间距、圆角、阴影、字号、行高、字重 ... */
}
```

消除了 4 个冲突的 `:root` 块，建立唯一真相源。

#### 2. 字体层级 6 级体系 (P1)

| 变量 | 值 | 用途 |
|------|-----|------|
| `--fs-display` | 26px | 页面标题 (topbar h1) |
| `--fs-h1` | 22px | 区块大标题 |
| `--fs-h2` | 17px | 面板标题 |
| `--fs-h3` | 15px | 小标题 / 表头 |
| `--fs-body` | 14px | 正文 (= base) |
| `--fs-caption` | 13px | 辅助说明 |
| `--fs-micro` | 12px | 标签 / 时间戳 |

基础字号从 13px 提升到 14px，中文可读性显著提升。h3 从 13px 提升到 15px，与正文建立明确区分。

#### 3. 字体加载修复 (P2)

**Before**: `font-family: Inter, "PingFang SC", ...` — Inter 未加载，声明无效
**After**: `font-family: "PingFang SC", "Microsoft YaHei UI", "HarmonyOS Sans SC", system-ui`

直接使用系统原生中文字体，零网络请求，macOS/Windows 渲染一致。

#### 4. 间距系统统一 (P1)

```css
--space-1: 4px;   --space-2: 8px;   --space-3: 12px;
--space-4: 16px;  --space-5: 20px;  --space-6: 24px;
--space-8: 32px;  --space-10: 40px;
```

所有关键选择器统一使用变量：
- `.panel` padding: `var(--space-5)` (20px，不再被覆盖)
- `.sidebar` padding: `var(--space-4) var(--space-3)`
- `.main` padding: `var(--space-5) var(--space-6) var(--space-8)`
- `.nav-item` padding: `0 var(--space-3)`

#### 5. 表格响应式 (P1)

| 表格 | Before | After | 降幅 |
|------|--------|-------|------|
| gallery-list-table | 1120px | 880px | -21% |
| processing-list-table | 1240px | 960px | -23% |
| order-table | 1280px | 1000px | -22% |
| shop-table | 980px | 760px | -22% |
| pending-list-table | 980/1380px | 760px | 统一 |

配合：
- 容器 `overflow-x: auto` + 6px 细滚动条
- 表头 `position: sticky; top: 0` 防穿透
- 表行 hover 背景高亮
- 窄屏下表格容器全宽 (`margin-inline: calc(var(--space-3) * -1)`)

#### 6. 响应式断点统一 (P2)

从 9 个零散断点统一为 3 个清晰断点：

| 断点 | 作用 |
|------|------|
| `max-width: 1280px` | 侧边栏收窄 (240px → 200px) |
| `max-width: 900px` | 侧边栏折叠为顶部横向导航 |
| `max-width: 480px` | 极小屏优化 (字号降至 13px) |

消除了 4 个冲突的 `@media(max-width: 900px)` 块。

#### 7. 色彩一致性 (P2)

将 200+ 硬编码色值统一到 CSS 变量：
- 深色文本: 4 种 → 1 种 (`--color-text`)
- 灰色: 5 种 → 1 种 (`--color-muted`)
- 边框: 4 种 → 1 种 (`--color-border`)
- 背景: 4 种 → 1 种 (`--color-bg`)

#### 8. 移除 !important (P2)

用更高特异性替代 6 处 `!important`：
```css
/* Before */
.gallery-media-label { color: #ffffff !important; }

/* After */
.gallery-media-label { color: #ffffff; font-size: var(--fs-micro); }
```

#### 9. 焦点态增强 (P3)

```css
button:focus-visible, input:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

input:focus-visible {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.12);
}
```

#### 10. 骨架屏 (P3)

新增 `.skeleton` / `.skeleton-line` 类，shimmer 动画加载占位：
```css
.skeleton {
  background: linear-gradient(90deg, var(--color-surface-soft) 25%, #eef2f7 50%, ...);
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.5s infinite;
}
```

#### 11. 空状态统一 (P3)

新增 `.empty-state` 组件类，统一图标 + 标题 + 描述结构。同时统一已有的零散空状态类 (`.log-empty` / `.empty-shop-state` / `.mockup-detail-empty`) 到一致样式。

#### 12. 无障碍 (P3)

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 三、文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/layout-fix.css` | **新增** | 380 行覆盖层 CSS，包含 12 项优化 |
| `src/main.tsx` | 修改 | 第 5 行后添加 `import "./layout-fix.css";` |
| `src/web-main.tsx` | 修改 | 第 5 行后添加 `import "./layout-fix.css";` |

**未改动**: `src/styles.css` (6493 行原文件保持不动)

---

## 四、后续优化建议

### 4.1 短期 (1-2 周)

1. **将原文件中的硬编码值迁移到变量** — 逐步将 `styles.css` 中的 `padding: 14px` 替换为 `padding: var(--space-3)` 等
2. **拆分 styles.css** — 按模块拆分为 `tokens.css` / `layout.css` / `components.css` / `pages.css` / `responsive.css`
3. **移除死代码** — 删除被覆盖的 3 个 `:root` 块和 3 个被覆盖的 `@media(max-width:900px)` 块
4. **在组件中使用骨架屏** — 在 `DashboardPage.tsx` / `OrdersPage.tsx` 等加载状态中替换为 `.skeleton` 类

### 4.2 中期 (2-4 周)

5. **拆分 OzonPage.tsx** — 4308 行拆分为 7 个 Tab 子组件
6. **提取共享组件** — Button / Input / Table / Modal / Badge 组件化
7. **CSS Modules 迁移** — 从全局 CSS 逐步迁移到 CSS Modules，消除类名冲突风险

### 4.3 长期 (1-2 月)

8. **Tailwind CSS 引入** — 新组件使用 Tailwind，旧组件逐步迁移
9. **暗色主题** — 基于 CSS 变量体系添加 `prefers-color-scheme: dark` 支持
10. **设计令牌自动化** — 使用 Style Dictionary 或手动维护 `tokens.json`，生成多平台令牌

---

## 五、验证清单

- [ ] 桌面端 (>1280px): 侧边栏 240px，内容区正常
- [ ] 笔记本 (1024-1280px): 侧边栏 200px，内容区正常
- [ ] 平板 (900-1024px): 侧边栏 200px，表格可横向滚动
- [ ] 手机 (<900px): 侧边栏折叠为顶部导航，表格全宽
- [ ] 极小屏 (<480px): 字号降至 13px，面板间距收窄
- [ ] h1/h2/h3 视觉层级清晰可辨
- [ ] 表格表头粘性正常，滚动时不穿透
- [ ] 输入框焦点有蓝色光晕
- [ ] 面板 hover 有阴影变化
- [ ] `prefers-reduced-motion` 下动画停止
- [ ] macOS Safari / Chrome 渲染一致
- [ ] Windows Chrome / Edge 渲染一致
