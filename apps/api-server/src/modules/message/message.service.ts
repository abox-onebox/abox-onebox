import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Message as MessageLog, MessageTemplate } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { WX_NOTIFY_PROVIDER, WxNotifyProvider } from '../../providers/wx-notify/wx-notify.provider';
import {
  MESSAGE_CHANNEL_LABEL,
  MESSAGE_TEMPLATE_SPEC_MAP,
  missingForEnable,
} from '../admin/template/message-template.specs';

export interface NotifyInput {
  /** 场景键（须在 `MESSAGE_TEMPLATE_SPECS` 内） */
  scene: string;
  /** 接收人（二选一即可；`ab_message` 两列都可空） */
  openid?: string | null;
  userId?: number | null;
  /** 微信订阅消息 data（已按微信 keyword 结构组装） */
  wxData?: Record<string, { value: string }>;
  /** 点击跳转的小程序页 */
  page?: string;
  /** 变量取值（连同 `scene` 一起落进日志 `payload`，便于事后核对发了什么） */
  variables?: Record<string, string>;
}

export interface NotifyResult {
  /** 是否真的投递了（`false` = 跳过，原因见 `reason`） */
  delivered: boolean;
  reason?: string;
  /** 投递是否成功（仅 `delivered=true` 时有意义） */
  ok?: boolean;
  errMsg?: string;
}

/**
 * 消息投递服务（M3-12）
 *
 * ## 职责
 * 按**场景**决定「发不发、发什么」，并落 `ab_message` 推送日志。
 * 渠道、变量、启用闸门全部来自 `message-template.specs.ts`（唯一真相），
 * 本服务不重复定义任何规则。
 *
 * ## ⚠️ 三条硬约束
 *
 * 1. **通知失败绝不影响业务**。退款已经成功、钱已经出去，此时通知失败只能是
 *    「这次没通知到」，不能让它把成功的交易变成失败 —— 故本服务**不抛异常**，
 *    所有问题都收敛进返回值（调用方按需记日志）。
 * 2. **调用点必须在业务事务之外**。事务里发了通知而事务回滚，就是「用户收到
 *    退款通知但退款并未发生」—— 退款链路最忌讳的「说不清」。故消费点统一放在
 *    `dataSource.transaction()` 返回之后。
 * 3. **未启用 = 不投递，且不留日志**。`ab_message` 的语义是「发过什么」，
 *    把「因为没启用所以没发」也写进去，会让这张表失去查询价值。
 */
@Injectable()
export class MessageService {
  private readonly logger = new Logger('Message');

  constructor(
    @InjectRepository(MessageLog)
    private readonly logRepo: Repository<MessageLog>,
    @InjectRepository(MessageTemplate)
    private readonly tplRepo: Repository<MessageTemplate>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @Inject(WX_NOTIFY_PROVIDER)
    private readonly wxNotify: WxNotifyProvider,
  ) {}

  /**
   * 投递一条场景通知
   *
   * 判定顺序：场景存在 → 场景已启用 → 渠道必要条件齐备 → 投递。
   * 任一步不通过即**跳过**（`delivered=false`），不落日志、不抛异常。
   */
  async notify(input: NotifyInput): Promise<NotifyResult> {
    const spec = MESSAGE_TEMPLATE_SPEC_MAP[input.scene];
    if (!spec) {
      this.logger.warn(`未知通知场景「${input.scene}」，已跳过`);
      return { delivered: false, reason: `未知场景「${input.scene}」` };
    }

    const row = await this.tplRepo.findOne({ where: { scene: input.scene } });
    const state = row
      ? {
          enabled: row.enabled,
          wechatTemplateId: row.wechatTemplateId ?? null,
          groupContent: row.groupContent ?? null,
        }
      : {
          enabled: spec.seed.enabled,
          wechatTemplateId: spec.seed.wechatTemplateId,
          groupContent: spec.seed.groupContent || null,
        };

    if (state.enabled !== 1) {
      return { delivered: false, reason: `场景「${spec.label}」未启用` };
    }

    // 渠道必要条件（与管理侧同一个判定函数 —— 规则不允许有两份）
    const blockers = missingForEnable(spec, state);
    if (blockers.length) {
      this.logger.warn(`场景「${spec.label}」已启用但配置不全，跳过投递：${blockers.join('；')}`);
      return { delivered: false, reason: blockers.join('；') };
    }

    // 只有「订阅消息」渠道会真正调用外部能力；`wechat_group` 是人工发群（文案存档）
    if (!spec.channels.includes('wechat_subscribe')) {
      return {
        delivered: false,
        reason: `场景「${spec.label}」仅含${spec.channels
          .map((c) => MESSAGE_CHANNEL_LABEL[c])
          .join('、')}，无程序投递点（文案供人工使用）`,
      };
    }

    const templateId = String(state.wechatTemplateId);

    // 收件人解析：调用方只给业务对象（`userId`），「userId → openid」的换算归投递侧 ——
    // 业务侧（退款、出餐…）不该关心 openid 从哪来，也不该为了发通知去 join 用户表
    let openid = input.openid ?? null;
    if (!openid && input.userId) {
      const u = await this.userRepo.findOne({
        where: { id: input.userId },
        select: { id: true, openid: true },
      });
      openid = u?.openid ?? null;
    }
    if (!openid) {
      this.logger.warn(
        `场景「${spec.label}」找不到收件人 openid（userId=${input.userId ?? '-'}），跳过投递`,
      );
      return { delivered: false, reason: '收件人 openid 缺失' };
    }

    let ok = false;
    let errMsg: string | undefined;

    try {
      const r = await this.wxNotify.send({
        openid,
        templateId,
        page: input.page,
        data: input.wxData ?? {},
      });
      ok = r.ok;
      errMsg = r.errMsg;
    } catch (e) {
      // ⚠️ 故意的吞异常：外部通道抖动不该让退款流程失败（见类头注释①）
      ok = false;
      errMsg = e instanceof Error ? e.message : String(e);
    }

    await this.writeLog({
      userId: input.userId ?? null,
      openid,
      templateId,
      payload: {
        scene: input.scene,
        sceneLabel: spec.label,
        variables: input.variables ?? {},
        wxData: input.wxData ?? {},
      },
      ok,
      errMsg,
    });

    if (!ok) {
      this.logger.warn(`通知投递失败（场景「${spec.label}」）：${errMsg ?? '未知原因'}`);
    }

    return { delivered: true, ok, errMsg };
  }

  /** 写推送日志（失败仅 WARN，绝不上抛 —— 与操作日志同一纪律） */
  private async writeLog(input: {
    userId: number | null;
    openid: string | null;
    templateId: string;
    payload: Record<string, unknown>;
    ok: boolean;
    errMsg?: string;
  }): Promise<void> {
    try {
      await this.logRepo.save(
        this.logRepo.create({
          userId: input.userId,
          openid: input.openid,
          templateId: input.templateId,
          payload: input.payload,
          status: input.ok ? 'success' : 'fail',
          errorMsg: input.errMsg ? input.errMsg.slice(0, 256) : null,
          sentAt: new Date(),
        }),
      );
    } catch (e) {
      this.logger.warn(
        `写 ab_message 日志失败（不影响业务）：${e instanceof Error ? e.message : e}`,
      );
    }
  }
}
