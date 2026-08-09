# Ozon SJSQ UI 设计系统规范

> 版本: 1.0 | 更新: 2026-08-08 | 适用: Tauri 桌面端 + Web 浏览器端  
> 设计目标: 美观、易用、一致、可扩展

---

## 一、设计原则

### 1.1 核心理念

| 原则 | 说明 |
|------|------|
| **信息密度优先** | 卖家工具需要高信息密度，但不可牺牲可读性。用间距和分组代替留白来区分层级 |
| **操作效率至上** | 高频操作（上传、上架、批量处理）路径最短，3 次点击内完成核心任务 |
| **状态即时反馈** | 所有异步操作有进度指示，所有状态变化有视觉反馈，不出现"不知道发生了什么"的空窗 |
| **一致性 > 创造性** | 同类组件在所有页面表现一致，降低用户认知负担 |
| **容错设计** | 危险操作二次确认，失败操作可重试，不因误操作丢失数据 |

### 1.2 设计约束

- **双模式适配**: Tauri 桌面窗口（最小 520x360）+ Web 浏览器（最宽 1680px）
- **中文字体优化**: PingFang SC / Microsoft YaHei UI 优先
- **13px 基准字号**: 卖家工具需要紧凑布局，13px 正文 + 12px 辅助文字
- **WCAG AA 合规**: 文本对比度 ≥ 4.5:1，交互元素 ≥ 3:1

---

## 二、色彩系统

### 2.1 品牌主色

```css
:root {
  --color-primary: #1677ff;        /* 主品牌色 - 按钮、链接、选中态 */
  --color-primary-strong: #0958d9; /* 加深 - hover/active */
  --color-primary-soft: #e6f4ff;   /* 浅底 - 选中背景、标签底色 */
  --color-primary-tint: #f0f7ff;   /* 更浅 - hover 背景 */
}
```

| 色值 | 用途 | 对比度 (白底) |
|------|------|---------------|
| #1677ff | 主按钮、链接、选中图标 | 3.7:1 (大文本合规) |
| #0958d9 | hover/active 态、深色强调 | 5.9:1 (合规) |
| #e6f4ff | 选中行背景、信息标签底色 | — |
| #f0f7ff | hover 背景、卡片浅底 | — |

### 2.2 语义色

```css
:root {
  /* Success */
  --color-success-bg: #ecfdf3;
  --color-success-border: #abefc6;
  --color-success-text: #067647;
  
  /* Warning */
  --color-warning-bg: #fff7e6;
  --color-warning-border: #ffe0a3;
  --color-warning-text: #ad6800;
  
  /* Error */
  --color-error-bg: #fef3f2;
  --color-error-border: #fecdca;
  --color-error-text: #b42318;
  
  /* Info */
  --color-info-bg: #e6f4ff;
  --color-info-border: #bae0ff;
  --color-info-text: #0958d9;
  
  /* Accent (用于 Mockup 相关) */
  --color-accent-bg: #f4f3ff;
  --color-accent-border: #d9d6fe;
  --color-accent-text: #5925dc;
}
```

### 2.3 中性色阶

```css
:root {
  --color-text: #1f2937;           /* 主文本 */
  --color-text-secondary: #4b5563; /* 次级文本 */
  --color-muted: #6b7280;          /* 辅助文本 */
  --color-subtle: #8a94a6;         /* 最弱文本/占位符 */
  
  --color-bg: #f3f5f9;             /* 页面背景 */
  --color-surface: #ffffff;        /* 卡片/面板背景 */
  --color-surface-soft: #f8fafc;   /* 次级面板背景 */
  
  --color-border: #e5e7eb;         /* 默认边框 */
  --color-border-strong: #d9dee8;  /* 强调边框 */
  --color-divider: #f1f3f7;        /* 分割线 */
}
```

### 2.4 阴影层级

```css
:root {
  --shadow-xs: 0 1px 2px rgba(15, 23, 42, 0.04);
  --shadow-sm: 0 2px 8px rgba(15, 23, 42, 0.04);
  --shadow-panel: 0 8px 22px rgba(15, 23, 42, 0.045);
  --shadow-modal: 0 16px 48px rgba(15, 23, 42, 0.12);
  --shadow-dropdown: 0 4px 16px rgba(15, 23, 42, 0.08);
}
```

---

## 三、字体系统

### 3.1 字体族

```css
:root {
  --font-sans: 'Inter', 'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
}
```

### 3.2 字号层级

| Token | 字号 | 行高 | 字重 | 用途 |
|-------|------|------|------|------|
| `--text-h1` | 22px | 1.25 | 600 | 页面标题 |
| `--text-h2` | 16px | 1.30 | 600 | 区块标题 |
| `--text-h3` | 14px | 1.35 | 500 | 卡片标题 |
| `--text-body` | 13px | 1.50 | 400 | 正文（默认） |
| `--text-caption` | 12px | 1.50 | 400 | 辅助文字、时间戳 |
| `--text-micro` | 11px | 1.40 | 400 | 徽章、标签内部 |

---

## 四、间距与圆角

### 4.1 间距系统（4px 基准）

```
4px  →  8px  →  12px  →  16px  →  24px  →  32px  →  48px  →  64px
```

| Token | 值 | 典型用途 |
|-------|----|----------|
| `--space-1` | 4px | 图标与文字间距 |
| `--space-2` | 8px | 按钮内图标间距、紧凑列表行距 |
| `--space-3` | 12px | 表单元素间距、标签内边距 |
| `--space-4` | 16px | 卡片内边距、列表项间距 |
| `--space-6` | 24px | 区块间距、卡片间距 |
| `--space-8` | 32px | 大区块间距 |
| `--space-12` | 48px | 页面级间距 |

### 4.2 圆角规范

| Token | 值 | 用途 |
|-------|----|------|
| `--radius-sm` | 4px | 小元素（标签内部） |
| `--radius-md` | 6px | 按钮、输入框（默认） |
| `--radius-lg` | 8px | 卡片、面板 |
| `--radius-xl` | 12px | 模态框、大型容器 |
| `--radius-pill` | 999px | 徽章、状态标签、开关 |

---

## 五、核心组件规范

### 5.1 按钮 Button

```
尺寸:     小(24px) | 中(32px, 默认) | 大(40px)
变体:     Primary | Secondary | Danger | Ghost | Icon
状态:     Default → Hover → Active → Disabled → Loading
```

| 变体 | Default | Hover | Active | Disabled |
|------|---------|-------|--------|----------|
| Primary | bg:#1677ff text:#fff | bg:#0958d9 | bg:#0958d9 opacity:0.85 | bg:#e5e7eb text:#9ca3af |
| Secondary | bg:#fff border:#d9dee8 | bg:#f8fafc border:#1677ff | bg:#f0f7ff | bg:#f3f4f6 text:#9ca3af |
| Danger | bg:#fff border:#fecdca text:#b42318 | bg:#fef3f2 | bg:#b42318 text:#fff | bg:#f3f4f6 text:#9ca3af |
| Ghost | bg:transparent | bg:#f0f7ff | bg:#e6f4ff | text:#9ca3af |

**交互规范**:
- 过渡动画: `transition: all 160ms ease`
- 最小高度: 32px（触屏设备建议 40px）
- 内边距: `0 10px`（中）/ `0 12px`（大）
- 焦点态: `outline: 2px solid #1677ff; outline-offset: 2px`
- Loading 态: 左侧显示 14px 旋转图标，文字变灰，禁用点击

### 5.2 表单元素

#### 输入框 Input
```
高度: 34px (默认) / 28px (紧凑)
圆角: 6px
边框: 1px solid #d9dee8 (default) → 1.5px solid #1677ff (focus) → 1px solid #fecdca (error)
背景: #ffffff → #fef3f2 (error)
内边距: 0 12px
焦点环: 0 0 0 3px rgba(22, 119, 255, 0.12)
```

#### 下拉选择 Select
```
触发器: 同 Input 样式
下拉面板: bg:#fff border:#e5e7eb radius:8px shadow:dropdown
选项: 高度 32px, hover bg:#f0f7ff, selected bg:#e6f4ff text:#0958d9
```

#### 开关 Toggle
```
尺寸: 44 x 24px
开启: bg:#1677ff, 圆点右移
关闭: bg:#e5e7eb, 圆点左移
过渡: 160ms ease
```

#### 复选框 Checkbox
```
尺寸: 16 x 16px
未选: border:#d9dee8 bg:#fff
选中: bg:#1677ff border:#1677ff
不确定: bg:#1677ff 横线图标
```

### 5.3 卡片 Card

```
背景: #ffffff
边框: 0.5px solid #e5e7eb
圆角: 8px
内边距: 16px (默认) / 24px (宽松)
阴影: var(--shadow-sm) 默认 → var(--shadow-panel) hover
```

**变体**:
- **数据卡片**: 顶部 3px 色条（#1677ff），标题 + 大数字 + 趋势
- **列表卡片**: 标题栏 + 内容区，带分割线
- **图片卡片**: 1:1 或 3:4 容器 + 底部信息条

### 5.4 徽章与状态标签 Badge

```
高度: 22-24px
圆角: 999px (pill)
内边距: 0 8px
字号: 11px
左侧圆点: 6px diameter
```

| 状态 | 背景 | 文字 | 圆点 |
|------|------|------|------|
| 运行中 | #ecfdf3 | #067647 | #067647 |
| 待处理 | #fff7e6 | #ad6800 | #ad6800 |
| 失败 | #fef3f2 | #b42318 | #b42318 |
| 已完成 | #ecfdf3 | #067647 | #067647 |
| 已停用 | #f3f4f6 | #4b5563 | #9ca3af |
| 信息 | #e6f4ff | #0958d9 | #0958d9 |

### 5.5 表格 Table

```
表头: bg:#f8fafc text:#4b5563 font-weight:500 高度:40px
行: bg:#ffffff 高度:44px hover bg:#f8fafc
边框: 仅底边 0.5px solid #f1f3f7
选中行: bg:#e6f4ff
分页: 右对齐, 页码按钮 28x28px
```

### 5.6 模态框 Modal

```
遮罩: rgba(15, 23, 42, 0.4) backdrop-filter:blur(2px)
面板: bg:#fff radius:12px shadow:modal
最大宽: 560px (标准) / 800px (宽) / 400px (确认框)
内边距: 24px
标题: 16px font-weight:600
关闭: 右上角 X 按钮
```

### 5.7 通知 Toast

```
位置: 右上角, 距顶部 16px, 距右 16px
宽度: 360px
圆角: 8px
阴影: var(--shadow-panel)
类型: success(绿) / warning(橙) / error(红) / info(蓝)
左侧色条: 4px width
自动消失: 4s (success) / 6s (warning) / 不消失 (error)
```

### 5.8 空状态 Empty State

```
容器: 虚线边框 #e5e7eb dashed, bg:#f8fafc
图标: 32px, 灰色 #d9dee8
标题: 13px text:#6b7280
描述: 12px text:#8a94a6
操作按钮: 可选, Secondary 样式
```

### 5.9 加载状态 Loading

```
骨架屏: bg:#f1f3f7, 圆角 6px, pulse 动画 1.5s
旋转图标: 14px (按钮内) / 20px (面板内) / 32px (全页)
进度条: 高度 6px, bg:#f1f3f7, fill bg:#1677ff, 圆角 3px
```

---

## 六、布局系统

### 6.1 整体布局

```
+----------------------------------------------------------+
| Sidebar (216px)  |  Main Content (max-width: 1680px)     |
|                  |                                        |
|  Brand           |  Topbar (54px)                         |
|  Nav Items       |  +----------------------------------+  |
|  ...             |  | Module Tabs (34px)               |  |
|                  |  +----------------------------------+  |
|  Assistant       |  |                                  |  |
|  Status          |  | Page Content                     |  |
|  (bottom)        |  |                                  |  |
|                  |  +----------------------------------+  |
+----------------------------------------------------------+
```

### 6.2 侧边栏 Sidebar

```
宽度: 216px (固定)
背景: #ffffff
右边框: 1px solid #e5e7eb
内边距: 12px

品牌区: 高度 54px, 图标 28x28 圆角 6px #1677ff
导航项: 高度 38px, 圆角 6px
  - 默认: text:#4b5563
  - Hover: bg:#f0f7ff text:#0958d9
  - Active: bg:#e6f4ff text:#0958d9 font-weight:600
子项: 高度 34px, 缩进 14px, font-size:12px

底部: 助手状态卡片
  - 连接状态圆点 (绿=已连接 / 橙=未连接)
  - 版本号
```

### 6.3 响应式断点

```css
/* 默认: 桌面端 (>1320px) */
.sidebar { width: 216px; }
.main { padding: 16px 22px 32px; }

/* 中等屏幕 (980px - 1320px) */
@media (max-width: 1320px) {
  .sidebar { width: 180px; }
  .main { padding: 16px 16px 32px; }
}

/* 平板 (760px - 980px) */
@media (max-width: 980px) {
  .sidebar { width: 56px; } /* 折叠为图标模式 */
  .main { padding: 12px 12px 24px; }
}

/* 手机 (<760px) */
@media (max-width: 760px) {
  .sidebar { display: none; } /* 抽屉模式 */
}
```

---

## 七、页面设计方案

### 7.1 Dashboard 首页

**布局**: 4 列 KPI 卡片 + 店铺健康矩阵 + 趋势图 + 最近任务

```
+--------------------------------------------------+
| 首页          [今日 v] [全部 v] [刷新数据]       |
+--------------------------------------------------+
| [今日单量]  [待备货]  [销售额]  [已上架商品]      |
|  1,247       83       ¥48.2K    3,456            |
|  +12.3%      需处理    +8.7%     +42 今日         |
+--------------------------------------------------+
| 店铺健康矩阵 (5家)        | 上架趋势 (7天柱状图)   |
| 旗舰店A    健康 92  ████  |  ▁ ▂ ▃ ▄ ▅ ▆ ▇       |
| 店铺B      健康 85  ███   |                       |
| 店铺C      健康 68  ██    |                       |
| 店铺D      健康 95  ████  |                       |
| 店铺E      健康 45  █     |                       |
+--------------------------------------------------+
| 最近任务  [3 运行中] [2 待处理]                   |
| ● 批量上传 48 张图片到旗舰店 A     2分钟前  完成   |
| ● AI 标题生成 — 店铺 B (32 件)      进行中   68%  |
+--------------------------------------------------+
```

**设计要点**:
- KPI 卡片顶部 3px 蓝色色条，数字用 22px font-weight:600
- 趋势值用绿色（正）/ 红色（负），带箭头图标
- 店铺健康度用进度条 + 颜色分级（绿 >80 / 橙 60-80 / 红 <60）
- 最近任务列表用状态圆点 + 时间戳 + 进度百分比

### 7.2 云图库页面

**布局**: 模块 Tab + 工具栏 + 图片网格 + 浮动批量操作栏

```
+--------------------------------------------------+
| [图片上传] 待上传(23) 上传中(5) 已上传(1847) 精品 |
+--------------------------------------------------+
| [grid] [list] | [全部店铺 v] [全部状态 v] [搜索] |
|               |                    [Mockup] [上传]|
+--------------------------------------------------+
| [img] [img] [img] [img] [img] [img]              |
| 已上传  已选   待上传  上传中  已上传  失败       |
| 旗舰店A        店铺B   68%    旗舰店A  店铺C     |
| [img] [img] [img] [img] [img] [img]              |
| 已上传 Mockup  已上传 已上传 已上传 已上传        |
+--------------------------------------------------+
| 已选择 1 张图片                                  |
| [生成Mockup] [自动上架] [删除]          [取消]   |
+--------------------------------------------------+
| 共 1,847 张 · 第 1/31页            [<] [1] [2] [>]|
+--------------------------------------------------+
```

**设计要点**:
- 图片卡片: 86x86px, 圆角 6px, 状态色标在底部信息条
- 选中态: 边框变 1.5px #1677ff, 右上角"已选"标签
- 上传中: 底部进度条 (6px 高)
- 失败: 左上角警告图标, 底部红色"失败"标签
- Mockup 已生成: 左上角紫色"M"标识
- 批量操作栏: 选中后从底部滑入, 深色背景 (#1f2937)
- 网格/列表视图切换: 工具栏最左侧 segmented control

### 7.3 自动上品任务中心

**布局**: 4 指标卡片 + 任务卡片列表

```
+--------------------------------------------------+
| [今日已上架]  [进行中]  [待处理]  [失败]         |
|   156 +42      8(5方案)  23排队    3需重试       |
+--------------------------------------------------+
| | 旗舰店A — 秋季新品上架              [运行中]   |
| | 方案: 批次10/缓冲5        68/100               |
| | ████████████████░░░░░░░░░░░░                   |
| | 成功65  待处理28  失败3  剩余7                 |
+--------------------------------------------------+
| | 店铺B — 跟卖同步                     [暂停]    |
| | 方案: 批次15/缓冲8        23/80                |
| | ████░░░░░░░░░░░░░░░░░░░░░░░░░░░               |
| | 成功20  待处理57  失败3                       |
+--------------------------------------------------+
```

**设计要点**:
- 任务卡片左侧 3px 状态色条（蓝=运行中 / 橙=暂停 / 绿=完成 / 红=失败）
- 进度条: 244px 宽, 6px 高, 圆角 3px, 底色 #f1f3f7, 填充 #1677ff
- 进度统计: 四列文字 (成功/待处理/失败/剩余), 各自语义色
- 操作按钮在卡片右侧: 暂停/继续/重试/释放/查看日志

### 7.4 Ozon 店铺管理页

**布局**: 7 Tab 切换 + Tab 内容区

```
+--------------------------------------------------+
| [上架商品] [更新商品] [下载订单] [跟卖同步]       |
| [库存价格] [浏览合并] [接口诊断]                  |
+--------------------------------------------------+
| Tab 内容区 (根据选中 Tab 渲染不同内容)            |
|                                                   |
| 上架商品 Tab:                                     |
|   店铺选择器 + 商品列表表格 + 操作按钮            |
|                                                   |
| 接口诊断 Tab:                                     |
|   API 连接测试 + 额度查询 + 错误日志              |
+--------------------------------------------------+
```

### 7.5 订单查询页

**布局**: 状态筛选 + 订单表格 + 批量下载

```
+--------------------------------------------------+
| [全部] [待备货] [备货中] [已发货] [已取消]        |
+--------------------------------------------------+
| 订单号    | 买家   | 商品   | 金额  | 状态 | 操作 |
| 24001...  | Ivan   | 手机壳  | ¥89   | 备货 | 下载 |
| 24002...  | Anna   | 数据线  | ¥45   | 发货 | 查看 |
+--------------------------------------------------+
| [下载标签] [下载条码] [下载拣货单]     [<] [1] [>]|
```

---

## 八、交互规范

### 8.1 过渡动画

| 场景 | 动画 | 时长 |
|------|------|------|
| 按钮 hover/active | background + border-color | 160ms ease |
| 侧边栏导航 hover | background | 160ms ease |
| 模态框打开 | opacity + translateY(8px → 0) | 200ms ease |
| 模态框关闭 | opacity + translateY(0 → 8px) | 160ms ease |
| Toast 出现 | opacity + translateX(20px → 0) | 240ms ease |
| Toast 消失 | opacity | 200ms ease |
| 批量操作栏 | translateY(100% → 0) | 200ms ease |
| 骨架屏脉冲 | opacity (0.5 → 1 → 0.5) | 1.5s ease-in-out infinite |
| 进度条 | width | 300ms ease |

### 8.2 键盘导航

- `Tab` 键: 在可交互元素间移动，焦点环 2px solid #1677ff
- `Enter`: 触发按钮点击 / 展开折叠项
- `Esc`: 关闭模态框 / 取消选中
- `Cmd/Ctrl + A`: 全选当前列表
- `Cmd/Ctrl + Click`: 多选（图片网格）
- `Shift + Click`: 范围选择（图片网格）

### 8.3 拖拽交互

- 图片上传: 支持拖拽文件到上传区域
- 虚线边框 → 实线蓝色边框 (drag-over)
- 释放后显示上传进度

### 8.4 危险操作确认

- 删除操作: 模态框二次确认，红色 Danger 按钮
- 批量删除: 显示数量，需手动输入"删除"确认
- 不可逆操作: 按钮文字明确说明后果

---

## 九、暗色主题（规划中）

```css
[data-theme="dark"] {
  --color-primary: #3b82f6;
  --color-primary-strong: #60a5fa;
  --color-primary-soft: #1e3a5f;
  --color-primary-tint: #172554;
  
  --color-text: #f1f5f9;
  --color-text-secondary: #cbd5e1;
  --color-muted: #94a3b8;
  --color-subtle: #64748b;
  
  --color-bg: #0f172a;
  --color-surface: #1e293b;
  --color-surface-soft: #334155;
  
  --color-border: #334155;
  --color-border-strong: #475569;
  --color-divider: #1e293b;
}
```

---

## 十、组件库实现建议

### 10.1 技术方案

```
src/
  components/          ← 新建: 基础 UI 组件库
    Button/
      Button.tsx
      Button.module.css
      index.ts
    Input/
    Select/
    Card/
    Badge/
    Table/
    Modal/
    Toast/
    EmptyState/
    Skeleton/
    index.ts           ← 统一导出
  features/            ← 已有: 业务页面
  lib/                 ← 已有: 工具组件
  styles/
    tokens.css         ← 新建: 设计令牌
    reset.css          ← 新建: 基础重置
    global.css         ← 已有 styles.css 重构而来
```

### 10.2 迁移策略

1. **Phase 1 (1周)**: 创建 `tokens.css`，将 `:root` 变量迁移过去。创建 Button、Input、Card 基础组件
2. **Phase 2 (2周)**: 逐页面替换原生 HTML 为组件，先从简单页面（License、Settings）开始
3. **Phase 3 (2周)**: 重构复杂页面（GalleryManager、OzonPage），拆分为子组件
4. **Phase 4 (1周)**: 添加 Toast 通知系统替换 console.log alert，添加 Skeleton 加载态
5. **Phase 5 (1周)**: 暗色主题支持

### 10.3 CSS 组织方式

```css
/* tokens.css — 设计令牌 */
:root {
  --color-primary: #1677ff;
  --space-4: 16px;
  --radius-md: 6px;
  /* ... */
}

/* Button.module.css — 组件级样式 */
.button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  border-radius: var(--radius-md);
  /* ... */
}

.primary {
  background: var(--color-primary);
  color: #fff;
}
```

使用 CSS Modules 替代全局 BEM 类名，避免样式冲突。每个组件自包含样式，便于维护和复用。

---

## 十一、无障碍设计

### 11.1 WCAG AA 合规

| 要求 | 标准 | 实现 |
|------|------|------|
| 文本对比度 | ≥ 4.5:1 (正常文本) / 3:1 (大文本) | 主文本 #1f2937 on #fff = 15:1 |
| 交互元素对比度 | ≥ 3:1 | 按钮边框 #d9dee8 on #fff = 1.3:1 (需加强) |
| 焦点可见 | 2px outline | `outline: 2px solid #1677ff` |
| 键盘可达 | 所有功能键盘可操作 | Tab 顺序逻辑化 |
| 触摸目标 | ≥ 44x44px | 按钮最小 32px (需在移动端放大) |

### 11.2 语义化 HTML

```tsx
// 正确
<nav role="navigation" aria-label="主导航">
  <button aria-current="page" aria-label="首页">首页</button>
</nav>

<main role="main">
  <h1>首页</h1>
  <section aria-label="数据概览">
    <article aria-label="今日单量">...</article>
  </section>
</main>
```

### 11.3 屏幕阅读器

- 图标按钮: 必须有 `aria-label`
- 表单: 关联 `<label>` + `aria-describedby` (错误信息)
- 动态内容: `aria-live="polite"` (Toast) / `aria-live="assertive"` (错误)
- 加载: `role="status"` + `aria-label="加载中"`

---

## 十二、设计交付清单

### 12.1 设计令牌文件
- [x] `tokens.css` — 色彩、字体、间距、阴影、圆角令牌
- [ ] `dark-tokens.css` — 暗色主题令牌

### 12.2 基础组件 (10 个)
- [ ] Button — 5 变体 × 3 尺寸 × 5 状态
- [ ] Input — text/password/number + error/disabled
- [ ] Select — 单选/多选/搜索
- [ ] Card — 数据卡片/列表卡片/图片卡片
- [ ] Badge — 6 种状态
- [ ] Table — 排序/分页/选择
- [ ] Modal — 确认框/表单框/信息框
- [ ] Toast — 4 种类型 + 自动消失
- [ ] EmptyState — 图标+标题+描述+操作
- [ ] Skeleton — 行/卡片/圆形

### 12.3 业务组件 (5 个)
- [ ] GalleryGrid — 图片网格 + 多选 + 批量操作
- [ ] TaskCard — 任务进度卡片
- [ ] StoreHealthBar — 店铺健康度
- [ ] KpiCard — KPI 指标卡片
- [ ] PageHeader — 页面标题栏 + 操作按钮

### 12.4 页面模板 (3 个)
- [ ] DashboardTemplate — KPI + 列表 + 图表
- [ ] ListPageTemplate — 工具栏 + 网格/表格 + 分页
- [ ] FormPageTemplate — 表单分组 + 验证 + 提交

---

## 附录: 设计令牌完整定义

```css
:root {
  /* ===== Color ===== */
  --color-primary: #1677ff;
  --color-primary-strong: #0958d9;
  --color-primary-soft: #e6f4ff;
  --color-primary-tint: #f0f7ff;
  
  --color-success-bg: #ecfdf3;
  --color-success-border: #abefc6;
  --color-success-text: #067647;
  
  --color-warning-bg: #fff7e6;
  --color-warning-border: #ffe0a3;
  --color-warning-text: #ad6800;
  
  --color-error-bg: #fef3f2;
  --color-error-border: #fecdca;
  --color-error-text: #b42318;
  
  --color-info-bg: #e6f4ff;
  --color-info-border: #bae0ff;
  --color-info-text: #0958d9;
  
  --color-accent-bg: #f4f3ff;
  --color-accent-border: #d9d6fe;
  --color-accent-text: #5925dc;
  
  --color-text: #1f2937;
  --color-text-secondary: #4b5563;
  --color-muted: #6b7280;
  --color-subtle: #8a94a6;
  
  --color-bg: #f3f5f9;
  --color-surface: #ffffff;
  --color-surface-soft: #f8fafc;
  
  --color-border: #e5e7eb;
  --color-border-strong: #d9dee8;
  --color-divider: #f1f3f7;
  
  /* ===== Typography ===== */
  --font-sans: 'Inter', 'PingFang SC', 'Microsoft YaHei UI', system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'SF Mono', 'Consolas', monospace;
  
  --text-h1: 22px;
  --text-h2: 16px;
  --text-h3: 14px;
  --text-body: 13px;
  --text-caption: 12px;
  --text-micro: 11px;
  
  --leading-tight: 1.25;
  --leading-snug: 1.35;
  --leading-normal: 1.5;
  
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
  
  /* ===== Spacing ===== */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --space-12: 48px;
  --space-16: 64px;
  
  /* ===== Radius ===== */
  --radius-sm: 4px;
  --radius-md: 6px;
  --radius-lg: 8px;
  --radius-xl: 12px;
  --radius-pill: 999px;
  
  /* ===== Shadow ===== */
  --shadow-xs: 0 1px 2px rgba(15, 23, 42, 0.04);
  --shadow-sm: 0 2px 8px rgba(15, 23, 42, 0.04);
  --shadow-panel: 0 8px 22px rgba(15, 23, 42, 0.045);
  --shadow-modal: 0 16px 48px rgba(15, 23, 42, 0.12);
  --shadow-dropdown: 0 4px 16px rgba(15, 23, 42, 0.08);
  
  /* ===== Transition ===== */
  --transition-fast: 160ms ease;
  --transition-normal: 240ms ease;
  --transition-slow: 400ms ease;
  
  /* ===== Z-index ===== */
  --z-base: 0;
  --z-dropdown: 100;
  --z-sticky: 200;
  --z-modal: 1000;
  --z-toast: 1100;
}
```
