import { Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { Request, Response } from 'express';
import { Public } from '../../common/decorators/auth.decorator';
import { WecomKbService } from './wecom-kb.service';

/**
 * 企业微信回调入口
 *
 *   GET  /wecom/kb/callback    → 后台填回调 URL 时的 URL 校验握手
 *   POST /wecom/kb/callback    → 同事发消息的回调
 *
 * ⚠️ 必须 @Public()：本端点由企业微信服务器回调，**不带任何 Bearer 令牌**，
 *    全局 JwtAuthGuard（APP_GUARD）会拦下未标 @Public() 的端点 ⇒ 回调直接 401，
 *    企业微信重试风暴 + 同事永远收不到回复。鉴权靠 WXBizMsgCrypt 签名验真（见 service）。
 *
 * POST 直接回 200 空体（结果走主动发消息，见 WecomKbService）。
 * 原始报文从 req.rawBody 取（main.ts 已开 rawBody:true），XML 不进 JSON body-parser。
 */
@Public()
@Controller('wecom/kb')
export class WecomKbController {
  constructor(private readonly svc: WecomKbService) {}

  @Get('callback')
  verify(@Query() q: Record<string, string>, @Res() res: Response): void {
    // 企业微信 URL 校验：响应体必须是解密后的 echostr 原始明文，
    // 故用 @Res 直接写出、绕过全局统一响应信封（否则包成 {code,data}
    // 会让企业微信的签名比对失败、后台「保存」过不了）。
    res.status(200).send(this.svc.verifyUrl(q));
  }

  @Post('callback')
  async handle(
    @Req() req: Request,
    @Query() q: Record<string, string>,
    @Res() res: Response,
  ): Promise<void> {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const raw = rawBody ? rawBody.toString('utf8') : '';
    await this.svc.handlePost(raw, q);
    // 立即回 200 空体（企业微信 5s 超时，处理异步进行），结果走主动发消息
    res.status(200).send('');
  }
}
