# 云后端接口说明

默认本地地址：

```text
http://127.0.0.1:8787
```

线上建议：

```text
https://api.你的域名.com
```

## 健康检查

```http
GET /health
```

返回：

```json
{
  "ok": true,
  "service": "ozon-sjsq-cloud",
  "time": "2026-06-28T00:00:00.000Z"
}
```

## 注册

```http
POST /auth/register
Content-Type: application/json
```

```json
{
  "phone": "手机号",
  "password": "密码",
  "licenseKey": "可选授权密钥",
  "deviceFingerprint": "桌面端设备指纹",
  "deviceName": "电脑名称"
}
```

## 登录

```http
POST /auth/login
Content-Type: application/json
```

```json
{
  "phone": "手机号",
  "password": "密码",
  "deviceFingerprint": "桌面端设备指纹",
  "deviceName": "电脑名称"
}
```

返回 `token` 后，后续请求使用：

```http
Authorization: Bearer 你的token
```

## 当前用户

```http
GET /me
Authorization: Bearer token
```

## 兑换会员

```http
POST /license/redeem
Authorization: Bearer token
Content-Type: application/json
```

```json
{
  "licenseKey": "OSJ-xxxx"
}
```

## 同步店铺

```http
POST /shops/upsert
Authorization: Bearer token
Content-Type: application/json
```

```json
{
  "externalShopId": "桌面端本地店铺ID",
  "name": "店铺名称",
  "ozonClientId": "Ozon Client-Id"
}
```

## 查询图库

```http
GET /gallery/assets?ratioFamily=portrait&keyword=ABC&hideUsed=true&limit=40&offset=0
Authorization: Bearer token
```

参数：

- `ratioFamily`：`portrait`、`square`、`landscape`、`wide`
- `keyword`：货号关键词
- `hideUsed`：是否隐藏当前账号已使用过的货号
- `limit`：每页数量，1-100，默认 40
- `offset`：分页偏移量，默认 0

返回：

```json
{
  "ok": true,
  "assets": [],
  "total": 120,
  "limit": 40,
  "offset": 0
}
```

## 上传图库图片

```http
POST /gallery/assets/upload
Authorization: Bearer token
Content-Type: multipart/form-data
```

字段：

- `file`：图片文件
- `sku`：可选货号，不填则使用文件名去扩展名

## 批量上传图库图片

```http
POST /gallery/assets/batch-upload
Authorization: Bearer token
Content-Type: multipart/form-data
```

字段：

- `files`：图片文件，可传多张，单次最多 50 张

返回：

```json
{
  "ok": true,
  "uploaded": 2,
  "failed": 0,
  "assets": [],
  "errors": []
}
```

批量上传按文件名生成货号，一张图片失败不会影响其它图片继续上传。
浏览器端的文件夹上传也复用这个接口：前端从用户选择的文件夹中筛出 PNG、JPG、JPEG、WebP 图片，并按每批最多 50 张自动分批调用本接口。

## 标记图片已用

```http
POST /gallery/assets/:assetId/use-by-external-shop
Authorization: Bearer token
Content-Type: application/json
```

```json
{
  "externalShopId": "桌面端本地店铺ID"
}
```

标记成功后，后续默认查询图库会过滤当前账号已使用过的同货号图片。

## 管理员后台

```text
GET /admin
```

使用 `.env` 里的 `ADMIN_TOKEN`。

## 管理员接口

生成授权密钥：

```http
POST /admin/license-keys
x-admin-token: ADMIN_TOKEN
Content-Type: application/json
```

```json
{
  "plan": "monthly",
  "count": 10
}
```

查询用户：

```http
GET /admin/users
x-admin-token: ADMIN_TOKEN
```

解绑设备：

```http
POST /admin/users/:userId/unbind-device
x-admin-token: ADMIN_TOKEN
```
