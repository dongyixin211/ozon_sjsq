# 云图库使用记录与过滤规则

## 目标

云图库需要实现：

```text
当前账号下所有店铺中，只要有一个店铺已经用过某个货号，默认就不再给这个账号显示该货号图片。
```

## 当前已实现接口

- `GET /gallery/assets`
  - 查询云图库
  - 支持 `ratioFamily`
  - 支持 `keyword`
  - 支持 `hideUsed=true`

- `POST /gallery/assets/upload`
  - 上传共享图片
  - 默认用图片文件名去扩展名作为货号
  - 可传 `sku` 覆盖货号

- `POST /gallery/assets/:assetId/use-by-external-shop`
  - 桌面端按本地店铺 ID 标记图片已使用
  - 后端会自动找到云端同步过的店铺

## 桌面端流程

```text
登录云服务
  -> 同步本地店铺
  -> 查询图库
  -> 选择“记录使用店铺”
  -> 点击图片上的“标记已用”
```

标记成功后，后端写入：

```text
gallery_usage
- user_id
- shop_id
- asset_id
- sku
- sha256
- used_at
```

之后再查询：

```text
GET /gallery/assets?hideUsed=true
```

后端会按 `user_id + sku` 过滤掉这个账号已用过的货号。

## 注意

如果提示“店铺还没有同步到云端”，先在云服务页点击“同步店铺”。
