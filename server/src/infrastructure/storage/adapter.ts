/**
 * infrastructure/storage/adapter.ts — 统一存储接口
 *
 * 定义 StorageAdapter 接口，R2 / 本地文件系统 均实现此接口。
 * 领域模块通过此接口访问存储，不关心底层实现。
 */

export interface StorageObject {
  key: string;
  size: number;
  lastModified: Date;
  contentType?: string;
}

export interface UploadOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface StorageAdapter {
  /** 上传文件 */
  upload(key: string, body: Buffer | ReadableStream, options?: UploadOptions): Promise<string>;

  /** 获取预签名下载 URL */
  getSignedUrl(key: string, expiresInSeconds?: number): Promise<string>;

  /** 获取预签名上传 URL */
  getUploadUrl(key: string, expiresInSeconds?: number, options?: UploadOptions): Promise<string>;

  /** 删除对象 */
  delete(key: string): Promise<void>;

  /** 列出对象 */
  list(prefix?: string, maxKeys?: number): Promise<StorageObject[]>;

  /** 检查对象是否存在 */
  exists(key: string): Promise<boolean>;
}

/** Phase 2: createR2Adapter / createLocalAdapter 工厂函数 */
