# 阿里云服务器部署文件

这些文件用于把 `server` 云后端部署到 Ubuntu 服务器。

## 服务器初始化

在服务器上用 root 执行：

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x
bash deploy/cloud-server/install-ubuntu.sh
```

如果不是通过仓库路径执行，也可以先把本目录上传到服务器，再执行：

```bash
sudo bash install-ubuntu.sh
```

## PostgreSQL 初始化

先修改 `postgres-init.sql` 里的密码，然后执行：

```bash
sudo -u postgres psql -f postgres-init.sql
```

对应 `server/.env`：

```env
DATABASE_URL=postgresql://ozon_sjsq:你的数据库密码@127.0.0.1:5432/ozon_sjsq_cloud
```

## 上传后端代码

建议部署目录：

```text
/opt/ozon-sjsq-cloud
```

服务器上执行：

```bash
cd /opt/ozon-sjsq-cloud/server
npm ci
npm run build
npm run migrate
```

## systemd

```bash
sudo cp /opt/ozon-sjsq-cloud/deploy/cloud-server/ozon-sjsq-cloud.service /etc/systemd/system/ozon-sjsq-cloud.service
sudo systemctl daemon-reload
sudo systemctl enable --now ozon-sjsq-cloud
sudo systemctl status ozon-sjsq-cloud
```

## Nginx

把 `nginx-api.conf` 里的 `api.example.com` 改成你的域名。

```bash
sudo cp nginx-api.conf /etc/nginx/sites-available/ozon-sjsq-cloud
sudo ln -s /etc/nginx/sites-available/ozon-sjsq-cloud /etc/nginx/sites-enabled/ozon-sjsq-cloud
sudo nginx -t
sudo systemctl reload nginx
```

Before restarting the backend on a 2-core / 4-GB server, set these values in `server/.env`:

```env
TITLE_GENERATION_GLOBAL_CONCURRENCY=2
TITLE_GENERATION_USER_CONCURRENCY=1
CLOUD_MOCKUP_REQUEST_CONCURRENCY=1
```

After deployment, verify the static asset cache and gzip response:

```bash
curl -I https://your-domain/app/assets/your-hashed-file.js
curl -H 'Accept-Encoding: gzip' -I https://your-domain/app/assets/your-hashed-file.js
sudo journalctl -u ozon-sjsq-cloud -f | grep 'slow request'
```

后续再用 Certbot 配 HTTPS。
