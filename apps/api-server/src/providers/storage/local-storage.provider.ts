import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { mkdir, writeFile, rm } from 'fs/promises';
import { dirname, join, resolve } from 'path';

import { StorageProvider, UploadInput, UploadResult } from './storage.provider';

/**
 * 本地磁盘存储（开发默认）
 *   文件落 LOCAL_UPLOAD_DIR（默认 ./data/uploads），
 *   通过 Nest 静态目录 /static 暴露，url 形如 http://localhost:3000/static/dishes/xxx.jpg
 */
@Injectable()
export class LocalStorageProvider extends StorageProvider {
  private readonly logger = new Logger('Storage:local');
  private readonly dir: string;
  private readonly publicBase: string;

  constructor(private readonly config: ConfigService) {
    super();
    const raw = this.config.get<string>('storage.local.dir') ?? './data/uploads';
    this.dir = resolve(process.cwd(), '..', '..', raw);
    const base =
      this.config.get<string>('storage.local.publicBase') ?? 'http://localhost:3000/static';
    this.publicBase = base.replace(/\/+$/, '');
  }

  get driver(): 'local' {
    return 'local';
  }

  async upload(input: UploadInput): Promise<UploadResult> {
    const target = join(this.dir, input.key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, input.buffer);
    this.logger.debug(`已写入本地文件：${target}`);
    return { key: input.key, url: this.url(input.key) };
  }

  async remove(key: string): Promise<void> {
    await rm(join(this.dir, key), { force: true });
  }

  url(key: string): string {
    return `${this.publicBase}/${key.replace(/^\/+/, '')}`;
  }

  /** 静态目录绝对路径（main.ts 注册 express.static 用） */
  get staticDir(): string {
    return this.dir;
  }
}
