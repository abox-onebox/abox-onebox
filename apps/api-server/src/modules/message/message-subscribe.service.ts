import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { MessageTemplate } from '../../database/entities/system.entity';
import {
  MESSAGE_SUBSCRIBE_NOTE,
  MESSAGE_TEMPLATE_SPECS,
  specState,
  subscribeTemplateOf,
} from '../admin/template/message-template.specs';

/** 出参：一条「可请求订阅授权」的场景 */
export interface SubscribeTemplateItemView {
  /** 场景键（端上只用于日志 / 埋点，**不要**拿它做业务分支） */
  scene: string;
  /** 场景中文名（端上不维护第二份文案） */
  label: string;
  /** 微信订阅消息模板 ID —— 直接作为 `requestSubscribeMessage` 的 `tmplIds` */
  templateId: string;
}

export interface SubscribeTemplateListView {
  list: SubscribeTemplateItemView[];
  /** 口径说明（**必须下发**：解释「列表为空通常是正常的」，见 specs） */
  note: string;
}

/**
 * 用户端订阅授权清单（M4-3 · U15 同节的读侧）
 *
 * ## 这个接口解决什么问题
 *
 * 微信订阅消息是**一次性授权**：用户没点过「允许」，服务端推了也白推
 * （微信回 `43101 用户拒绝接收`）。所以在「申请退款」「成为团长」这类
 * **用户按一下、之后可能几天后才需要通知**的动作上，端上必须在**用户还有交互的
 * 那一刻**请求授权。
 *
 * 请求授权需要 `tmplIds`（微信模板 ID），它由**运营在后台 P36 配置**
 * （`ab_message_template.wechat_template_id`）。端上**不能硬编码** ——
 * 硬编码就是第二份真相：运营换了模板，端上还在请求旧 ID，而两边都不报错。
 * 故由本接口下发。
 *
 * ## 为什么「返回空」是常态而不是故障
 *
 * 一期没有微信账号 → 模板 ID 全为空 → `subscribeTemplateOf()` 第 4 个条件不成立
 * → 列表为空。**端上拿到空数组应当什么都不做**（不调 `requestSubscribeMessage`），
 * 而不是拿一个假 ID 去试。这条已写进 `MESSAGE_SUBSCRIBE_NOTE` 一并下发，
 * 免得端上或运维把「空」理解成「接口坏了」。
 *
 * ## 为什么不在这里做「上报」（U15 `POST /me/subscribe`）
 *
 * ⚠️ **如实标注：U15 上报一期未实装**，且**不是漏了**：
 *   · 上报的授权结果（`accept` / `reject`）**服务端投递时并不需要** ——
 *     微信会在发送响应里直接回 `43101`，要不要发这件事不依赖本地记录；
 *   · 它唯一的价值是**统计/审计**（「多少人拒绝了」），而落这条记录**需要新表**
 *     （`ab_message` 是推送日志，语义是「发过什么」，塞授权结果会污染它）——
 *     新增第 28 张表属独立的 DDL 评审项，且一期**无微信账号无法真实验证**。
 *   故本批次**只做读侧**（端上真正需要的那一半）。写入端的空位在此明确留名，
 *   避免以后有人以为「U15 做过了」。
 */
@Injectable()
export class MessageSubscribeService {
  private readonly logger = new Logger('MessageSubscribe');

  constructor(
    @InjectRepository(MessageTemplate)
    private readonly tplRepo: Repository<MessageTemplate>,
  ) {}

  /**
   * 当前**可以让用户授权**的场景清单
   *
   * 判定完全交给 `subscribeTemplateOf()`（specs 内四条件：用户端场景 / 已接线 /
   * 已启用 / 已配模板 ID）—— 本方法只负责取数，**不自己判断**。
   */
  async list(): Promise<SubscribeTemplateListView> {
    const rows = await this.tplRepo.find();
    const byScene = new Map(rows.map((r) => [r.scene, r]));

    const list: SubscribeTemplateItemView[] = [];
    for (const spec of MESSAGE_TEMPLATE_SPECS) {
      const templateId = subscribeTemplateOf(spec, specState(spec, byScene.get(spec.scene)));
      if (templateId) {
        list.push({ scene: spec.scene, label: spec.label, templateId });
      }
    }

    // 库里有、声明里没有的场景 → 不展示（代码不会用它投递），但**大声记日志**：
    // 与 `MessageTemplateService.list()` 同一纪律，静默无视会让脏数据永远没人发现。
    for (const r of rows) {
      if (!MESSAGE_TEMPLATE_SPECS.some((s) => s.scene === r.scene)) {
        this.logger.warn(
          `ab_message_template 存在已下线场景「${r.scene}」(id=${r.id})，未纳入出参`,
        );
      }
    }

    return { list, note: MESSAGE_SUBSCRIBE_NOTE };
  }
}
