# 商品上架临时图片上传限制调整

日期：2026-08-11

## 调整内容

- 取消 `POST /legacy-listing/uploads/presign` 的单张图片大小上限。
- 取消该接口的上传频率限制。
- 取消该接口的临时图片总容量限制，不再返回 `507 GALLERY_STORAGE_LIMIT_EXCEEDED`。
- 保留图片类型、文件名、SKU、登录与会员权限、对象归属和上传完成后的元数据校验。
- 客户端收到任意 HTTP 507 时改为中文提示：云端存储服务暂时不可用，请稍后重试；持续出现时联系管理员检查服务器存储。

## 影响范围

- 仅取消“商品上架本地图片直传”路径的容量和频率控制。
- 普通图库的存储额度校验保持不变。
- 旧版图库批量上传的文件数和批次大小限制保持不变。

## 验证

- `cd server && npm test -- src/routes/legacy-listing-upload-routes.test.ts`
- `cd server && npm run check`
- `cd src-tauri && cargo test cloud_upload_error_hides_raw_507_status`
