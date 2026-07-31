# Ozon SJSQ 云端后端

这个目录是商业版的云端后端骨架，负责：

- 手机号 + 密码登录
- 授权密钥兑换会员
- 月卡 99、季卡 249、年卡 899
- 一个账号只允许绑定一台电脑
- 云端共享图库
- 按图片比例筛选
- 按货号过滤用户已使用过的图片
- 通过服务端连接 Cloudflare R2 / Backblaze B2，避免把存储密钥放进桌面端

## 本地启动

1. 安装依赖：

```bash
npm install
```

2. 复制配置：

```bash
copy .env.example .env
```

3. 修改 `.env`：

```env
JWT_SECRET=换成至少24位随机字符串
ADMIN_TOKEN=换成管理员口令
DATABASE_URL=postgresql://用户名:密码@127.0.0.1:5432/数据库名
STORAGE_ENDPOINT=https://你的ACCOUNT_ID.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY_ID=你的R2 Access Key
STORAGE_SECRET_ACCESS_KEY=你的R2 Secret Key
STORAGE_BUCKET=ozon-sjsq-gallery
STORAGE_PUBLIC_BASE_URL=https://你的图片域名
```

4. 初始化数据库：

```bash
npm run migrate
```

5. 启动开发服务：

```bash
npm run dev
```

健康检查地址：

```text
http://127.0.0.1:8787/health
```

如果本机安装了 Docker，可以先启动本地 PostgreSQL：

```bash
docker compose up -d
npm run migrate
npm run dev
```

再开一个终端执行核心接口烟测：

```bash
npm run smoke
```

检查数据库和对象存储配置：

```bash
npm run doctor
```

初始化生产 `.env`：

```bash
npm run env:init
```

服务器上生成授权密钥：

```bash
npm run keys:create -- monthly 10
npm run keys:create -- quarterly 10
npm run keys:create -- yearly 10
```

管理员后台：

```text
http://127.0.0.1:8787/admin
```

## 授权密钥

生成月卡：

```bash
curl -X POST http://127.0.0.1:8787/admin/license-keys ^
  -H "Content-Type: application/json" ^
  -H "x-admin-token: 你的ADMIN_TOKEN" ^
  -d "{\"plan\":\"monthly\",\"count\":10}"
```

套餐：

| 套餐 | 价格 | 有效期 |
|---|---:|---:|
| 月卡 | 99 | 31 天 |
| 季卡 | 249 | 92 天 |
| 年卡 | 899 | 365 天 |

## 图库过滤逻辑

图片上传后，服务端会记录：

- `sku`：图片文件名去掉扩展名后的货号
- `sha256`：图片内容指纹
- `width` / `height`：宽高
- `ratio`：宽高比
- `ratio_family`：`portrait`、`square`、`landscape`、`wide`

当桌面端请求：

```text
GET /gallery/assets?ratioFamily=portrait&hideUsed=true
```

服务端会隐藏当前账号已经在任意店铺使用过的货号。这个逻辑对应你的要求：当前用户下所有店铺中，只要有一个店铺已经用过这个货号，图库里就不再给这个用户显示。

## 阿里云部署建议

生产环境建议：

- 阿里云 ECS：2 核 2G 起步
- 系统：Ubuntu 22.04 / 24.04
- Node.js：22 LTS
- 数据库：PostgreSQL 16
- 进程管理：PM2 或 systemd
- 反向代理：Nginx
- HTTPS：Let's Encrypt 证书

服务器上执行：

```bash
npm ci
npm run build
npm run migrate
npm run start
```

正式部署时，桌面端只配置你的后端 API 地址，例如：

```text
https://api.你的域名.com
```

不要把 R2 Secret、数据库密码、管理员口令写进桌面端。
