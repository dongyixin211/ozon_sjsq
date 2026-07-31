# Cloudflare R2 注册与配置记录

## 注册入口

1. 打开 Cloudflare：

```text
https://dash.cloudflare.com/
```

2. 登录后进入：

```text
Storage & databases -> R2
```

3. 首次使用需要开通 R2 subscription。

注意：R2 可以免费开始使用，但后台可能仍要求绑定付款方式。正式商业项目一定要设置预算提醒。

## Bucket

建议创建：

```text
ozon-sjsq-gallery
```

存储类型先用：

```text
Standard
```

## API Token

创建 R2 Token 时建议：

```text
权限：Object Read & Write
范围：只授权 ozon-sjsq-gallery 这个 bucket
```

保存这些值：

```env
STORAGE_ENDPOINT=https://你的ACCOUNT_ID.r2.cloudflarestorage.com
STORAGE_ACCESS_KEY_ID=你的 Access Key ID
STORAGE_SECRET_ACCESS_KEY=你的 Secret Access Key
STORAGE_BUCKET=ozon-sjsq-gallery
STORAGE_PUBLIC_BASE_URL=https://img.你的域名.com
```

Secret Access Key 只显示一次。

## 图片访问域名

建议绑定：

```text
img.你的域名.com
```

路径：

```text
R2 bucket -> Settings -> Custom Domains -> Add domain
```

不要长期用 `r2.dev` 做正式商业图库域名。
