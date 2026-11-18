import { Controller, Post, UseInterceptors, UploadedFile, Inject, HttpCode } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiConsumes } from '@nestjs/swagger';
import { extname } from 'path';
import { randomUUID } from 'crypto';

import { CurrentUser, JwtPayload } from '../../common/decorators/auth.decorator';
import { BizException } from '../../common/exceptions/biz.exception';
import { ErrorCode } from '../../common/constants/error-code';
import { STORAGE_PROVIDER, StorageProvider } from '../../providers/storage/storage.provider';
import { UserService } from './user.service';

/**
 * 用户头像上传（2026-11-18 · 微信 chooseAvatar 一键采用）
 *
 * ## 为什么单独一个 controller 而不复用后台 /admin/uploads
 * 后台端点挂 `AdminGuard + Roles`，小程序用户 token 进不来；本端点是**用户态**，
 * 只靠全局 `JwtAuthGuard`（APP_GUARD）鉴权，`/me/avatar` 不在 ADMIN_SCOPE，
 * 用户 token 可用。`@CurrentUser().sub` 即本人 user id，不接受外部传 id。
 *
 * ## 数据流
 * 小程序 `button open-type="chooseAvatar"` → 拿到临时路径 → `uni.uploadFile` 传本端点
 * → storage 落盘（本地驱动 /static 或 COS）→ 写 `ab_user.avatar_url` → 返回持久 url。
 * 前端 `chooseAvatar` 的临时路径**不可直接入库**（会话结束即失效），必须经此换持久地址。
 *
 * ## 限制
 * 头像压到 ≤2MB（chooseAvatar 拿到的微信头像通常几百 KB）；表单字段名 `file`。
 */
interface UploadedShape {
  buffer: Buffer;
  originalname?: string;
  mimetype?: string;
}

@ApiTags('用户·头像')
@ApiBearerAuth()
@Controller('me/avatar')
export class UserAvatarController {
  constructor(
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly userService: UserService,
  ) {}

  @Post()
  @HttpCode(201)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 2 * 1024 * 1024 } }))
  @ApiOperation({
    summary: '用户 · 上传并更新头像（chooseAvatar 一键采用）',
    description:
      '单文件，表单字段名 `file`，≤2MB。存入对象存储/本地静态目录后写本人 `ab_user.avatar_url`，' +
      '返回持久 URL。小程序 chooseAvatar 的临时路径须经此端点换成持久地址。',
  })
  async upload(@CurrentUser() user: JwtPayload, @UploadedFile() file?: UploadedShape) {
    if (!file || !file.buffer || file.buffer.length === 0) {
      throw new BizException(ErrorCode.PARAM_INVALID, '缺少上传文件');
    }
    const ext = extname(file.originalname ?? '').toLowerCase() || '.png';
    const key = `avatars/${user.sub}/${randomUUID()}${ext}`;
    const res = await this.storage.upload({
      key,
      buffer: file.buffer,
      contentType: file.mimetype,
    });
    await this.userService.updateAvatar(user.sub, res.url);
    return { url: res.url };
  }
}
