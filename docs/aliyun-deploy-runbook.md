# 阿里云部署执行手册

## 1. 上传代码

在 Windows 本机执行：

```powershell
.\deploy-cloud-server.ps1 -SshTarget root@你的服务器IP
```

如果不是 root：

```powershell
.\deploy-cloud-server.ps1 -SshTarget 用户名@你的服务器IP
```

脚本会上传：

```text
server/
deploy/cloud-server/
```

不会上传：

```text
server/.env
server/node_modules
server/dist
```

## 2. 初始化服务器

SSH 到服务器：

```bash
ssh root@你的服务器IP
```

执行：

```bash
cd /opt/ozon-sjsq-cloud
sudo bash deploy/cloud-server/install-ubuntu.sh
```

## 3. 配置 PostgreSQL

先修改密码：

```bash
nano deploy/cloud-server/postgres-init.sql
```

执行：

```bash
sudo -u postgres psql -f deploy/cloud-server/postgres-init.sql
```

## 4. 配置后端环境变量

```bash
cd /opt/ozon-sjsq-cloud/server
npm run env:init
nano .env
```

必须填写真实值：

```env
JWT_SECRET=至少24位随机字符串
ADMIN_TOKEN=管理员口令
DATABASE_URL=postgresql://ozon_sjsq:你的数据库密码@127.0.0.1:5432/ozon_sjsq_cloud
STORAGE_ENDPOINT=https://你的ACCOUNT_ID.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY_ID=你的R2 Access Key
STORAGE_SECRET_ACCESS_KEY=你的R2 Secret
STORAGE_BUCKET=ozon-sjsq-gallery
STORAGE_PUBLIC_BASE_URL=https://img.你的域名.com
```

## 5. 构建和迁移

```bash
npm ci
npm run build
npm run migrate
npm run doctor
```

## 6. 启动服务

```bash
sudo cp /opt/ozon-sjsq-cloud/deploy/cloud-server/ozon-sjsq-cloud.service /etc/systemd/system/ozon-sjsq-cloud.service
sudo systemctl daemon-reload
sudo systemctl enable --now ozon-sjsq-cloud
sudo systemctl status ozon-sjsq-cloud
```

## 7. Nginx

修改域名：

```bash
nano /opt/ozon-sjsq-cloud/deploy/cloud-server/nginx-api.conf
```

复制并重载：

```bash
sudo cp /opt/ozon-sjsq-cloud/deploy/cloud-server/nginx-api.conf /etc/nginx/sites-available/ozon-sjsq-cloud
sudo ln -sf /etc/nginx/sites-available/ozon-sjsq-cloud /etc/nginx/sites-enabled/ozon-sjsq-cloud
sudo nginx -t
sudo systemctl reload nginx
```

## 8. 验证

```bash
curl http://127.0.0.1:8787/health
curl http://api.你的域名.com/health
```

看到下面内容表示后端已起来：

```json
{"ok":true,"service":"ozon-sjsq-cloud"}
```

## 9. 生成会员授权密钥

```bash
cd /opt/ozon-sjsq-cloud/server
npm run keys:create -- monthly 10
npm run keys:create -- quarterly 10
npm run keys:create -- yearly 10
```

密钥只显示一次，数据库里只保存哈希。

也可以打开管理员后台：

```text
https://api.你的域名.com/admin
```

使用 `.env` 中的 `ADMIN_TOKEN` 进入。
