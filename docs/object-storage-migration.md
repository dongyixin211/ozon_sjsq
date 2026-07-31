# 图库存储迁移到对象存储

当前线上图库历史数据在服务器本地目录：

```text
/opt/ozon-sjsq-cloud/uploads
```

迁移目标是把 `gallery`、`gallery-thumbs`、`gallery-ozon` 和样机预览文件上传到 OSS/COS/R2 这类 S3 兼容对象存储，数据库里的图片 URL 改成新的公开域名。迁移完成并验证稳定前，不要删除本地目录。

## 推荐配置

阿里云 OSS 使用 AWS S3 SDK 时，Endpoint 使用 S3 兼容格式：

```env
STORAGE_PROVIDER=oss
STORAGE_ENDPOINT=https://s3.oss-cn-beijing.aliyuncs.com
STORAGE_REGION=cn-beijing
STORAGE_BUCKET=你的bucket
STORAGE_PUBLIC_BASE_URL=https://你的图片域名
STORAGE_FORCE_PATH_STYLE=false
```

如果用 Cloudflare R2：

```env
STORAGE_PROVIDER=r2
STORAGE_ENDPOINT=https://你的account_id.r2.cloudflarestorage.com
STORAGE_REGION=auto
STORAGE_BUCKET=你的bucket
STORAGE_PUBLIC_BASE_URL=https://你的图片域名
STORAGE_FORCE_PATH_STYLE=true
```

## 迁移步骤

先在服务器上执行 dry-run，只检查本地文件和数据库记录：

```bash
cd /opt/ozon-sjsq-cloud/server
MIGRATE_STORAGE_PROVIDER=oss \
MIGRATE_STORAGE_ENDPOINT=https://s3.oss-cn-beijing.aliyuncs.com \
MIGRATE_STORAGE_REGION=cn-beijing \
MIGRATE_STORAGE_BUCKET=你的bucket \
MIGRATE_STORAGE_PUBLIC_BASE_URL=https://你的图片域名 \
MIGRATE_STORAGE_ACCESS_KEY_ID=你的AccessKeyId \
MIGRATE_STORAGE_SECRET_ACCESS_KEY=你的AccessKeySecret \
MIGRATE_STORAGE_DRY_RUN=true \
npm run storage:migrate
```

确认没有异常后上传对象，但先不改数据库：

```bash
MIGRATE_STORAGE_DRY_RUN=false \
MIGRATE_STORAGE_UPDATE_DB=false \
npm run storage:migrate
```

抽样访问新域名图片正常后，再更新数据库 URL：

```bash
MIGRATE_STORAGE_DRY_RUN=false \
MIGRATE_STORAGE_UPDATE_DB=true \
MIGRATE_STORAGE_OLD_PUBLIC_BASE_URL=https://api.dyxtoolai.cn/uploads \
npm run storage:migrate
```

最后把 `server/.env` 的 `STORAGE_PROVIDER`、`STORAGE_ENDPOINT`、`STORAGE_PUBLIC_BASE_URL` 等配置切到对象存储，重启服务并验证：

```bash
npm run doctor
systemctl restart ozon-sjsq-cloud
curl -fsS https://api.dyxtoolai.cn/health
```

## 删除本地文件前的检查

只有满足这些条件才可以删除本地图库：

- 新上传图片已经写入对象存储；
- 图库页面、上传中、已上传图片、精品图库都能正常显示；
- Ozon 能下载新图片链接；
- `gallery-ozon` 的历史上架图片链接已经迁移并抽样可访问；
- 本地备份至少保留 3 到 7 天。

删除前建议先改名观察，而不是直接删除：

```bash
mv /opt/ozon-sjsq-cloud/uploads /opt/ozon-sjsq-cloud/uploads.local-backup
systemctl restart ozon-sjsq-cloud
```

观察正常后再清理备份。
