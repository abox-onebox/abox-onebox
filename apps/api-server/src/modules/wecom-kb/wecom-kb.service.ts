import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { WecomCryptoService } from './wecom-crypto.service';
import { WecomTokenService } from './wecom-token.service';
import { OpProxyService, Binding, ProxyResult } from './op-proxy.service';
import { WecomBindingService } from './wecom-binding.service';
import { WecomSvcTokenService } from './wecom-svc-token.service';
import { WecomChatService } from './wecom-chat.service';
import { looksLikeStructuredCommand } from './chat-flow';
import { execTierOf } from './op-policy';
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
    private readonly svcTokenSvc: WecomSvcTokenService,
    private readonly chat: WecomChatService,
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
    // 先认人：没绑定就不知道「谁在办事」，审计里也留不下真人姓名
    const binding = await this.bindingSvc.get(fromUser);
    if (!binding) {
      await this.tokenSvc.sendText(
        fromUser,
        '你的企业微信账号还没绑到后台。\n请管理员在后台「企业微信绑定」页把你加进来（userid=' +
          fromUser +
          '）。',
      );
      return;
    }

    // 执行身份按**身份等级**取（binding.tier）：
    //   owner → admin 角色服务账号（131 个后台端点全可达）
    //   staff → operator 角色服务账号（69 个；其余由后台 @Roles 直接拒绝）
    // 两者都是自续令牌，使用者完全不碰令牌。
    //
    // ⚠️ 例外：同事有**单独放权清单**时必须升到 owner 账号。
    //    被放权的端点（如退款审批）`@Roles` 里没有 operator，用 operator 令牌打过去
    //    会被后台 403 —— 现象是「后台明明点了放权，机器人还说做不了」。
    //    安全性不依赖身份本身，而依赖 op-policy 按清单逐条判（执行入口 + 展示层各一次）：
    //    清单外的端点在 `execCatalog` 里就被 403 挡掉，根本发不到后台。
    const tier = binding.tier === 'owner' ? 'owner' : 'staff';
    const grantedOps = binding.grantedOps || [];
    // 身份升级规则见 `op-policy.execTierOf`（试跑台用的是同一个函数，不另写一份）
    const execTier = execTierOf(tier, grantedOps);
    const svcToken = await this.svcTokenSvc.get(execTier);
    const execToken = svcToken ?? binding.operatorToken ?? null;
    if (!execToken) {
      const need =
        execTier === 'owner'
          ? 'WECOM_OWNER_USERNAME / WECOM_OWNER_PASSWORD（负责人执行账号）'
          : 'WECOM_SVC_USERNAME / WECOM_SVC_PASSWORD（同事执行账号）';
      await this.tokenSvc.sendText(
        fromUser,
        `机器人还没配好「${execTier === 'owner' ? '负责人' : '同事'}」执行账号：${need}。\n请联系管理员补齐后重试。`,
      );
      return;
    }

    const b: Binding = {
      operatorName: binding.operatorName,
      operatorToken: execToken,
      approverToken: binding.approverToken,
      tier,
      grantedOps,
    };

    // ── 人话入口 ──────────────────────────────────────────────
    // 除「结构化指令」（执行/提交/查询/撤回/审批…）之外，全部当成同事在说人话：
    // 认楼、认套餐、认日子，缺什么问什么，最后回 1 才写库。
    if (!looksLikeStructuredCommand(content)) {
      const reply = await this.chat.reply(fromUser, content, b);
      await this.tokenSvc.sendText(fromUser, reply);
      return;
    }

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

    // 审批必须真人：approverToken 只认绑定表里的，**绝不**回落服务账号 ——
    // 否则「谁批的」会变成机器人自己，动钱的操作就失去了人工闸门。
    if ((intent.kind === 'approve' || intent.kind === 'reject') && !binding.approverToken) {
      await this.tokenSvc.sendText(
        fromUser,
        '你的账号没有审批权限（未绑定审批人令牌）。\n审批必须由负责人本人在后台完成。',
      );
      return;
    }

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
    // 令牌被判失效（10002 = 鉴权失败）：作废缓存，下一条消息自动重新登录，
    // 不让同事看到「全部失败」却不知道为什么
    if (res.code === 10002 && svcToken) this.svcTokenSvc.invalidate(execTier);

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
