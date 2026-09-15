import { registerAs } from '@nestjs/config';

/**
 * 对象存储配置（菜品图 / 营业执照 / 头像）
 *   cos   —— 腾讯云 COS（生产）
 *   minio —— 本地容器（贴近生产的 S3 语义，docker compose --profile oss up -d）
 *   local —— 本地磁盘（零依赖，文件落 ./data/uploads，由 /static 暴露）
 */
export interface StorageConfig {
  driver: 'cos' | 'minio' | 'local';
  cos: { secretId: string; secretKey: string; bucket: string; region: string };
  minio: { endpoint: string; accessKey: string; secretKey: string; bucket: string };
  local: { dir: string; publicBase: string };
}

export default registerAs(
  'storage',
  (): StorageConfig => ({
    driver: (process.env.STORAGE_DRIVER ?? 'local') as StorageConfig['driver'],
    cos: {
      secretId: process.env.COS_SECRET_ID ?? '',
      secretKey: process.env.COS_SECRET_KEY ?? '',
      bucket: process.env.COS_BUCKET ?? '',
      region: process.env.COS_REGION ?? 'ap-beijing',
    },
    minio: {
      endpoint: process.env.MINIO_ENDPOINT ?? 'http://127.0.0.1:9000',
      accessKey: process.env.MINIO_ACCESS_KEY ?? 'abox',
      secretKey: process.env.MINIO_SECRET_KEY ?? 'abox123456',
      bucket: process.env.MINIO_BUCKET ?? 'abox-uploads',
    },
    local: {
      dir: process.env.LOCAL_UPLOAD_DIR ?? './data/uploads',
      publicBase: process.env.LOCAL_UPLOAD_PUBLIC_BASE ?? 'http://localhost:3000/static',
    },
  }),
);
