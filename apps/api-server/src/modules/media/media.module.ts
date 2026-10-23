import { Module } from '@nestjs/common';
import { MediaController } from './media.controller';

/**
 * 后台 · 媒体上传模块（独立 · 通用上传端点）
 *
 * `STORAGE_PROVIDER` 由全局的 `ProvidersModule`（@Global）提供，本模块无需再 import。
 */
@Module({ controllers: [MediaController] })
export class MediaModule {}
