import { Controller, Get, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { WecomKbService } from './wecom-kb.service';

/**
 * 企业微信回调入口
 *
 *   GET  /wecom/kb/callback    → 后台填回调 URL 时的 URL 校验握手
 *   POST /wecom/kb/callback    → 同事发消息的回调
 *
 * POST 直接回 200 空体（结果走主动发消息，见 WecomKbService）。
 * 原始报文从 req.rawBody 取（main.ts 已开 rawBody:true），XML 不进 JSON body-parser。
 */
@Controller('wecom/kb')
export class WecomKbController {
  constructor(private readonly svc: WecomKbService) {}

  @Get('callback')
  verify(@Query() q: Record<string, string>): string {
    return this.svc.verifyUrl(q);
  }

  @Post('callback')
  async handle(@Req() req: Request, @Query() q: Record<string, string>): Promise<string> {
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody;
    const raw = rawBody ? rawBody.toString('utf8') : '';
    await this.svc.handlePost(raw, q);
    return '';
  }
}
