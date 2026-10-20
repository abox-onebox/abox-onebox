import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WecomCryptoService } from './wecom-crypto.service';
import { WecomTokenService } from './wecom-token.service';
import { OpProxyService, Binding, ProxyResult } from './op-proxy.service';
import { WecomBindingService } from './wecom-binding.service';
import { parseCommand, Intent, HELP_TEXT } from './command-parser';

/**
 * 编排：企业微信回调 → 验签解密 → 解析指令 → 取令牌绑定 → 调 op 代理 → 异步下发结果
 *
 * 关键设计：
 *   · 回调 POST **立即回 200 空体**，真正处理异步进行（企业微信 5s 超时，避免重试风暴）；
 *   · 用 MsgId 做 5 分钟去重，重试不会重复执行写操作；
 *   · 结果通过企业微信主动发消息接口回给同事（不走被动 XML 回复，省去加密回包）。
 */
@Injectable()
export class WecomKbService implements OnModuleInit {
  private readonly logger = new Logger(WecomKbService.name);
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly crypto: WecomCryptoService,
    private readonly tokenSvc: WecomTokenService,
    private readonly proxy: OpProxyService,
    private readonly bindingSvc: WecomBindingService,
  ) {}

  onModuleInit(): void {
    this.crypto.runSelfTest();
  }

  /** GET URL 校验：企业微信后台填回调 URL 时的握手，返回解密后的 echostr 明文 */
  verifyUrl(q: Record<string, string>): string {
    if (!q.msg_signature || !q.timestamp || !q.nonce || !q.echostr) return '';
    if (!this.crypto.verifyMsgSignature(q.msg_signature, q.timestamp, q.nonce, q.echostr)) {
      this.logger.warn('企业微信 URL 校验签名不符');
      return '';
    }
    try {
      return this.crypto.decrypt(q.echostr).message;
    } catch (e) {
      this.logger.error('企业微信 URL 校验解密失败：' + (e as Error).message);
      return '';
    }
  }

  /** POST 消息回调 */
  async handlePost(rawXml: string, q: Record<string, string>): Promise<void> {
    try {
      const encrypt = this.xmlTag(rawXml, 'Encrypt');
      if (!encrypt) {
        this.logger.warn('企业微信回调缺少 Encrypt 节点');
        return;
      }
      if (!q.msg_signature || !q.timestamp || !q.nonce) {
        this.logger.warn('企业微信回调缺少签名参数');
        return;
      }
      if (!this.crypto.verifyMsgSignature(q.msg_signature, q.timestamp, q.nonce, encrypt)) {
        this.logger.warn('企业微信回调签名不符，丢弃');
        return;
      }
      const { message } = this.crypto.decrypt(encrypt);
      const fromUser = this.xmlTag(message, 'FromUserName') || '';
      const msgId = this.xmlTag(message, 'MsgId') || '';
      const content = (this.xmlTag(message, 'Content') || '').trim();
      if (!fromUser || !content) return;

      const now = Date.now();
      if (msgId && this.seen.has(msgId) && (this.seen.get(msgId) as number) > now) {
        this.logger.log('重复消息，跳过 MsgId=' + msgId);
        return;
      }
      if (msgId) this.seen.set(msgId, now + 5 * 60 * 1000);

      void this.process(fromUser, content);
    } catch (e) {
      this.logger.error('企业微信回调处理异常：' + (e as Error).message);
    }
  }

  private async process(fromUser: string, content: string): Promise<void> {
    const intent = parseCommand(content);
    if (intent.kind === 'help') {
      await this.tokenSvc.sendText(fromUser, HELP_TEXT);
      return;
    }
    if (intent.kind === 'unknown') {
      await this.tokenSvc.sendText(
        fromUser,
        '指令无法识别：「' + intent.raw + '」\n发送「帮助」查看可用指令。',
      );
      return;
    }

    const binding = await this.bindingSvc.get(fromUser);
    if (!binding) {
      await this.tokenSvc.sendText(
        fromUser,
        '你的企业微信账号尚未绑定 KB 令牌。请联系管理员在后台「企业微信绑定」页预绑定 userid=' +
          fromUser +
          '。',
      );
      return;
    }
    const b: Binding = {
      operatorName: binding.operatorName,
      operatorToken: binding.operatorToken,
      approverToken: binding.approverToken,
    };

    let res: ProxyResult = { code: -1, message: '未处理', data: null };
    switch (intent.kind) {
      case 'my_requests':
        res = await this.proxy.query('q_my_requests', intent.params, b);
        break;
      case 'query':
        res = await this.proxy.query(intent.qCode, intent.params, b);
        break;
      case 'exec':
        res = await this.proxy.exec(intent.opCode, intent.params, b, content);
        break;
      case 'submit':
        res = await this.proxy.submit(intent.opCode, intent.params, b, content);
        break;
      case 'recall':
        res = await this.proxy.recall(intent.requestId, intent.reason, b, content);
        break;
      case 'approve':
        res = await this.proxy.approve(intent.requestId, b, content);
        break;
      case 'reject':
        res = await this.proxy.reject(intent.requestId, intent.reason, b, content);
        break;
    }
    await this.tokenSvc.sendText(fromUser, this.format(intent, res));
  }

  private format(intent: Intent, res: ProxyResult): string {
    const head = this.intentHead(intent);
    if (res.code === 0) {
      let extra = '';
      if (res.data && typeof res.data === 'object') {
        const d = res.data as Record<string, unknown>;
        if (d.id) extra += '\n单号 #' + d.id;
        if (d.status) extra += ' · 状态 ' + d.status;
      }
      return head + ' 成功' + extra + (res.message ? '\n' + res.message : '');
    }
    return head + ' 失败（code ' + res.code + '）\n' + (res.message || '无错误信息');
  }

  private intentHead(intent: Intent): string {
    switch (intent.kind) {
      case 'exec':
        return '执行 ' + intent.opCode;
      case 'submit':
        return '提交 ' + intent.opCode;
      case 'recall':
        return '撤回 ' + intent.requestId;
      case 'query':
        return '查询 ' + intent.qCode;
      case 'my_requests':
        return '我的审批进度';
      case 'approve':
        return '审批通过 ' + intent.requestId;
      case 'reject':
        return '审批拒绝 ' + intent.requestId;
      default:
        return '';
    }
  }

  private xmlTag(xml: string, tag: string): string {
    const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)</' + tag + '>').exec(xml || '');
    return m ? m[1] : '';
  }
}
