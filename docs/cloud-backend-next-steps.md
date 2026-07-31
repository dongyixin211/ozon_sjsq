# 云端后端下一步配置清单

本地已经新增 `server` 后端工程。要真正跑通商业版云图库，需要继续准备这些内容。

## 你需要准备

1. Cloudflare R2
   - 创建 bucket：`ozon-sjsq-gallery`
   - 创建 R2 API Token
   - 记录 Account ID、Access Key ID、Secret Access Key

2. 域名
   - 后端接口域名：建议 `api.你的域名.com`
   - 图片访问域名：建议 `img.你的域名.com`

3. 阿里云服务器
   - 安装 Node.js 22
   - 安装 PostgreSQL 16
   - 安装 Nginx
   - 配置 HTTPS
   - 安全组开放 80、443

4. 后端环境变量
   - `JWT_SECRET`
   - `ADMIN_TOKEN`
   - `DATABASE_URL`
   - `STORAGE_ENDPOINT`
   - `STORAGE_ACCESS_KEY_ID`
   - `STORAGE_SECRET_ACCESS_KEY`
   - `STORAGE_BUCKET`
   - `STORAGE_PUBLIC_BASE_URL`

## 本地开发启动

双击项目根目录：

```text
start-cloud-server-dev.bat
```

第一次启动会自动复制：

```text
server\.env.example -> server\.env
```

然后需要手动填写真实配置。

如果本机或服务器有 Docker，可以在 `server` 目录启动本地 PostgreSQL：

```bash
docker compose up -d
npm run migrate
npm run dev
npm run smoke
```

部署文件自检：

```powershell
.\scripts\check-cloud-deploy-assets.ps1
```

## 后续开发顺序

1. 配好 R2 和数据库，让 `server` 可以真实启动
2. 桌面端新增登录页
3. 桌面端新增会员状态栏
4. 桌面端新增云图库页面
5. 商品发布/更新模块接入云图库选图
6. 增加简单管理员后台

## 重要安全原则

不要把下面这些值写入桌面端：

- R2 Secret
- 数据库密码
- `ADMIN_TOKEN`
- `JWT_SECRET`

这些只能放在阿里云服务器的 `server/.env` 里。
