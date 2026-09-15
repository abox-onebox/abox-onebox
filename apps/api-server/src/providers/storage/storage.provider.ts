/**
 * 对象存储能力抽象（菜品图 / 证照 / 头像）
 *   local —— 本地磁盘（零依赖，默认；文件落 ./data/uploads，由 /static 暴露）
 *   cos   —— 腾讯云 COS（生产）
 *   minio —— 本地容器（可选）
 */
export const STORAGE_PROVIDER = Symbol('STORAGE_PROVIDER');

export interface UploadInput {
  /** 相对 key，如 dishes/2026/09/xx.jpg */
  key: string;
  buffer: Buffer;
  contentType?: string;
}

export interface UploadResult {
  key: string;
  url: string;
}

export abstract class StorageProvider {
  abstract get driver(): 'local' | 'cos' | 'minio';
  abstract upload(input: UploadInput): Promise<UploadResult>;
  abstract remove(key: string): Promise<void>;
  abstract url(key: string): string;
}

/**
 * 云端存储占位实现
 *
 * 补齐依赖后启用：
 *   pnpm --filter api-server add cos-nodejs-sdk-v5
 *   → 实现 cos/minio（MinIO 兼容 S3，可用同一 SDK 指向自定义 endpoint）
 * 当前直接抛错，避免静默降级导致图片「上传成功但访问 404」。
 */
export class PendingCloudStorageProvider extends StorageProvider {
  constructor(private readonly target: 'cos' | 'minio') {
    super();
  }

  get driver(): 'cos' | 'minio' {
    return this.target;
  }

  private notReady(): never {
    throw new Error(
      `STORAGE_DRIVER=${this.target} 尚未启用：请先安装 cos-nodejs-sdk-v5 并补全实现，` +
        `或改用 STORAGE_DRIVER=local（本地磁盘，开发期推荐）`,
    );
  }

  async upload(): Promise<UploadResult> {
    this.notReady();
  }

  async remove(): Promise<void> {
    this.notReady();
  }

  url(): string {
    this.notReady();
  }
}
