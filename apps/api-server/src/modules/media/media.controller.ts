import {
  Controller,
  Post,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Inject,
  HttpCode,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { extname } from 'path';
import { randomUUID } from 'crypto';

import { STORAGE_PROVIDER, StorageProvider } from '../../providers/storage/storage.provider';
import { AdminGuard } from '../../common/guards/admin.guard';
import { Roles } from '../../common/decorators/auth.decorator';
import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';

/**
 * 后台 · 媒体上传（图片）
 *
 * ## 为什么单独成模块
 * 与任何业务域无关（供应商照片、商品图、头像都复用同一端点），放供应商模块会把「通用上传」
 * 绑死在供应商语义上。独立模块 + 全局可注入的 `STORAGE_PROVIDER`（ProvidersModule 已 @Global）。
 *
 * ## 字段与限制
 * 单文件，表单字段名 `file`，≤10MB。返回 `{ url }`——本地驱动下即 `/static/...`，
 * 生产接 COS 后返回 CDN 地址（驱动切换对调用方透明）。
 *
 * ## 用途
 * 当前主要为「门店实拍 / 证照照片」（供应商照片墙）。上传拿到 url 后由
 * `PUT /admin/suppliers/:id/photos` 写入 `ab_supplier.store_photos`。
 */
// 仅取必要字段，避免强依赖 @types/multer（与项目其它处一致的结构化轻量类型）
interface UploadedShape {
  buffer: Buffer;
  originalname?: string;
  mimetype?: string;
}

@ApiTags('后台·媒体上传')
@ApiBearerAuth()
@Controller('admin/uploads')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin', 'operator')
export class MediaController {
  constructor(@Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider) {}

  @Post()
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 10 * 1024 * 1024 } }))
  @ApiOperation({
    summary: '后台 · 上传媒体文件（图片）',
    description:
      '单文件上传，表单字段名 `file`，上限 10MB。返回可访问 URL（本地驱动经 /static 暴露；' +
      '生产接 COS 后返回 CDN 地址）。供「门店实拍 / 证照照片」等场景使用——' +
      '拿到 url 后由 `PUT /admin/suppliers/:id/photos` 写入。\n\n' +
      '⚠️ 远程图在端上真正可见的前提：域名完成 ICP 备案 + 小程序后台配置 `downloadFile` 合法域名白名单。',
  })
  async upload(@UploadedFile() file?: UploadedShape) {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, '缺少上传文件');
    }
    const ext = extname(file.originalname ?? '').toLowerCase() || '.jpg';
    const datePart = new Date().toISOString().slice(0, 10);
    const key = `uploads/${datePart}/${randomUUID()}${ext}`;
    const res = await this.storage.upload({
      key,
      buffer: file.buffer,
      contentType: file.mimetype,
    });
    return { url: res.url };
  }
}
