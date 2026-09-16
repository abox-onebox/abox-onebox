import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BizException } from '../../../common/exceptions/biz.exception';
import { ErrorCode } from '../../../common/constants/error-code';
import { MessageTemplate } from '../../../database/entities/system.entity';
import { UpdateMessageTemplateDto } from '../dto/message-template.dto';
import {
  CHANNEL_REQUIREMENT,
  MESSAGE_CHANNEL_LABEL,
  MESSAGE_TEMPLATE_NOTE,
  MESSAGE_TEMPLATE_SPECS,
  MESSAGE_TEMPLATE_SPEC_MAP,
  MessageTemplateSpec,
  MessageTemplateState,
  findUnknownVariables,
  missingForEnable,
} from './message-template.specs';

/** 出参：单个渠道的状态 */
export interface MessageTemplateChannelView {
  key: string;
  label: string;
  /** 该渠道的必要条件字段名（页面据此把「缺什么」对应到具体输入框） */
  requirementField: string;
  requirementFieldLabel: string;
  /** 必要条件当前是否已满足 */
  requirementMet: boolean;
}

/** 出参：单条模板 */
export interface MessageTemplateItemView {
  /** 库中行 id；`persisted=false` 时为 null（页面只能看，保存后才有 id） */
  id: number | null;
  /** 库中是否已有这一行（false = 仍在用种子默认值） */
  persisted: boolean;
  scene: string;
  label: string;
  audience: string;
  channels: MessageTemplateChannelView[];
  trigger: string;
  mandatory: boolean;
  variables: string[];
  enabled: boolean;
  wechatTemplateId: string | null;
  groupContent: string | null;
  /** 字段级接线状态（逐字段说清「改了会不会生效」） */
  fieldWiring: {
    enabled: string;
    wechatTemplateId: string;
    groupContent: string;
  };
  /** 场景级接线状态：`live` = 有代码投递点 */
  wiring: string;
  pendingReason?: string;
  consumedBy: string;
  note?: string;
  /** 现在能否启用（= `blockers` 为空） */
  canEnable: boolean;
  /** 启用还缺什么（逐条中文说明，页面直接展示） */
  blockers: string[];
  updatedBy: number | null;
  updatedAt: string | null;
}

export interface MessageTemplateListView {
  list: MessageTemplateItemView[];
  summary: { total: number; enabled: number; live: number; pending: number };
  note: string;
}

export interface MessageTemplateUpdateResult {
  item: MessageTemplateItemView;
  changed: Array<{ field: string; label: string; before: string; after: string }>;
  note: string;
}

/** 字段中文名（变更回执与页面共用） */
const FIELD_LABEL: Record<string, string> = {
  enabled: '启用状态',
  wechatTemplateId: '微信订阅消息模板 ID',
  groupContent: '微信群通知文案',
};

/**
 * 通知模板服务（D59 / D60）
 *
 * ## 与 `ConfigService` 的对称设计
 *
 * 两者都遵循「**声明驱动**」：`message-template.specs.ts` 之于本服务，
 * 相当于 `config.specs.ts` 之于 `ConfigService` —— 一份声明同时驱动出参结构、
 * 可写白名单、闸门规则与页面控件。区别只在粒度：配置是**扁平标量**，
 * 模板是**结构化实体**（故有独立表，而不是塞进 `ab_config`）。
 *
 * ## 为什么**不引入缓存**
 *
 * 全表 5 行、只在「管理页打开」与「产生一条退款通知」时读取，属低频路径；
 * 一次主键索引查询的开销远小于引入进程内缓存后必须维护的失效逻辑
 * （M3-10 的 `BizConfigService` 之所以有缓存，是因为配置在**每次下单/结算**
 * 都被读）。**没有缓存，就没有「写完忘了失效」这一类 bug**。
 * 若将来读频率上来，加缓存时必须同时补 `invalidate()` 调用点 —— 在此备注。
 */
@Injectable()
export class MessageTemplateService {
  private readonly logger = new Logger('MessageTemplate');

  constructor(
    @InjectRepository(MessageTemplate)
    private readonly repo: Repository<MessageTemplate>,
  ) {}

  /** D59 模板清单（以代码声明为准，库行只补可编辑值） */
  async list(): Promise<MessageTemplateListView> {
    const rows = await this.repo.find();
    const byScene = new Map(rows.map((r) => [r.scene, r]));

    // ⚠️ 库中有、声明中没有的场景行 → 不展示（代码不会用它投递），但**大声记日志**：
    //    它多半来自「场景已下线但种子没重跑」，静默无视会让库里的脏数据永远没人发现。
    for (const r of rows) {
      if (!MESSAGE_TEMPLATE_SPEC_MAP[r.scene]) {
        this.logger.warn(
          `ab_message_template 存在已下线场景「${r.scene}」(id=${r.id})，未纳入出参`,
        );
      }
    }

    const list = MESSAGE_TEMPLATE_SPECS.map((spec) => this.toView(spec, byScene.get(spec.scene)));

    return {
      list,
      summary: {
        total: list.length,
        enabled: list.filter((i) => i.enabled).length,
        live: list.filter((i) => i.wiring === 'live').length,
        pending: list.filter((i) => i.wiring === 'pending').length,
      },
      note: MESSAGE_TEMPLATE_NOTE,
    };
  }

  /**
   * D60 编辑单条模板
   *
   * 校验顺序刻意如此：
   *   ① 「至少改了一项」—— 空请求不是幂等成功，而是没有意义的调用
   *   ② 变量白名单 —— 文案里写了不存在的变量，发出去就是给用户看 `{{foo}}` 原文
   *   ③ 启用闸门 —— **按「改动后的最终状态」判定**，而不是只看本次提交的字段：
   *      否则可以「先清空模板 ID，再单独发一次 enabled=1」绕开闸门
   */
  async update(
    id: number,
    dto: UpdateMessageTemplateDto,
    operatorId: number,
  ): Promise<MessageTemplateUpdateResult> {
    const row = await this.repo.findOne({ where: { id } });
    if (!row) {
      throw new BizException(ErrorCode.NOT_FOUND, `通知模板 #${id} 不存在`);
    }

    const spec = MESSAGE_TEMPLATE_SPEC_MAP[row.scene];
    if (!spec) {
      // 库里有这行，但它对应的场景已从代码中下线 —— 对调用方与「不存在」是同一件事
      throw new BizException(
        ErrorCode.NOT_FOUND,
        `通知模板 #${id} 对应的场景「${row.scene}」已不在支持列表内，无法编辑`,
      );
    }

    if (
      dto.enabled === undefined &&
      dto.wechatTemplateId === undefined &&
      dto.groupContent === undefined
    ) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        '没有需要更新的字段（可编辑项：启用状态 / 微信订阅消息模板 ID / 微信群通知文案）',
      );
    }

    const finalState: MessageTemplateState = {
      enabled: dto.enabled !== undefined ? dto.enabled : row.enabled,
      wechatTemplateId: this.normalize(dto, 'wechatTemplateId', row.wechatTemplateId ?? null),
      groupContent: this.normalize(dto, 'groupContent', row.groupContent ?? null),
    };

    const problems: string[] = [];

    // ② 变量白名单
    if (finalState.groupContent) {
      const unknown = findUnknownVariables(finalState.groupContent, spec.variables);
      if (unknown.length) {
        problems.push(
          `文案里的变量 ${unknown.map((v) => `{{${v}}}`).join('、')} 不在本场景白名单内` +
            `（可用：${spec.variables.map((v) => `{{${v}}}`).join('、') || '无'}）—— ` +
            '写错的变量在发送时不会被替换，用户会直接看到 `{{...}}` 原文',
        );
      }
    }

    // ③ 启用闸门（按最终状态判定）
    if (finalState.enabled === 1) {
      problems.push(...missingForEnable(spec, finalState));
    }

    if (problems.length) {
      throw new BizException(
        ErrorCode.PARAM_INVALID,
        `通知模板校验未通过：${problems.join('；')}`,
        undefined,
        { fields: problems },
      );
    }

    const before = this.snapshot(row);
    row.enabled = finalState.enabled;
    row.wechatTemplateId = finalState.wechatTemplateId;
    row.groupContent = finalState.groupContent;
    row.updatedBy = operatorId;
    const saved = await this.repo.save(row);

    const changed = this.diff(before, this.snapshot(saved));
    if (changed.length) {
      this.logger.log(
        `运营 #${operatorId} 更新通知模板「${spec.label}」：` +
          changed.map((c) => `${c.label} ${c.before} → ${c.after}`).join(' | '),
      );
    }

    return {
      item: this.toView(spec, saved),
      changed,
      note: changed.length
        ? `已更新 ${changed.length} 项（启用状态即时生效；文案字段为台账/人工使用）`
        : '提交内容与当前值一致，未写入任何数据',
    };
  }

  // ------------------------------------------------------------------ 内部

  /**
   * 取「改动后」的字段值
   *
   * ⚠️ 判据是 `!== undefined`，**不是** `'field' in dto`。
   *    DTO 实例的类字段以 `undefined` 初始化，`in` 恒为 `true`，
   *    会把「未传」误判成「传了 undefined 要清空」（见 DTO 头注）。
   *
   * 空串按**清空**处理（与 `null` 同义）：运营删光输入框就是「不要这个值了」，
   * 若存成空串，`missingForEnable` 里 `trim() === ''` 会判为缺失 —— 两边一致，
   * 但库里留空串会让「未配置」有两种表示。故在此归一到 `null`。
   */
  private normalize(
    dto: UpdateMessageTemplateDto,
    field: 'wechatTemplateId' | 'groupContent',
    current: string | null,
  ): string | null {
    const incoming = dto[field];
    if (incoming === undefined) return current;
    if (incoming === null) return null;
    const trimmed = String(incoming).trim();
    return trimmed === '' ? null : trimmed;
  }

  private snapshot(row: MessageTemplate): MessageTemplateState {
    return {
      enabled: row.enabled,
      wechatTemplateId: row.wechatTemplateId ?? null,
      groupContent: row.groupContent ?? null,
    };
  }

  private diff(
    before: MessageTemplateState,
    after: MessageTemplateState,
  ): Array<{ field: string; label: string; before: string; after: string }> {
    const out: Array<{ field: string; label: string; before: string; after: string }> = [];
    const show = (v: unknown): string => {
      if (v === null || v === undefined || v === '') return '（空）';
      if (typeof v === 'number') return v === 1 ? '启用' : '关闭';
      const s = String(v);
      return s.length > 40 ? `${s.slice(0, 40)}…` : s;
    };

    for (const field of ['enabled', 'wechatTemplateId', 'groupContent'] as const) {
      const b = field === 'enabled' ? (before.enabled === 1 ? 1 : 0) : before[field];
      const a = field === 'enabled' ? (after.enabled === 1 ? 1 : 0) : after[field];
      if (b === a) continue;
      // enabled 是数字、其余是字符串：统一成可读文本再比，避免 1 与 '1' 判等不一致
      if (String(b ?? '') === String(a ?? '')) continue;
      out.push({
        field,
        label: FIELD_LABEL[field],
        before: field === 'enabled' ? (b === 1 ? '启用' : '关闭') : show(b),
        after: field === 'enabled' ? (a === 1 ? '启用' : '关闭') : show(a),
      });
    }
    return out;
  }

  private toView(spec: MessageTemplateSpec, row?: MessageTemplate): MessageTemplateItemView {
    // 库中无行 → 用声明里的种子值展示，并标记 `persisted=false`
    const state: MessageTemplateState = row
      ? this.snapshot(row)
      : {
          enabled: spec.seed.enabled,
          wechatTemplateId: spec.seed.wechatTemplateId,
          groupContent: spec.seed.groupContent || null,
        };

    const blockers = missingForEnable(spec, state);

    return {
      id: row?.id ?? null,
      persisted: Boolean(row),
      scene: spec.scene,
      label: spec.label,
      audience: spec.audience,
      channels: spec.channels.map((ch) => {
        const req = CHANNEL_REQUIREMENT[ch];
        const v = state[req.field];
        return {
          key: ch,
          label: MESSAGE_CHANNEL_LABEL[ch],
          requirementField: req.field,
          requirementFieldLabel: req.fieldLabel,
          requirementMet: !(v === null || v === undefined || String(v).trim() === ''),
        };
      }),
      trigger: spec.trigger,
      mandatory: spec.mandatory,
      variables: spec.variables,
      enabled: state.enabled === 1,
      wechatTemplateId: state.wechatTemplateId,
      groupContent: state.groupContent,
      fieldWiring: {
        enabled: 'live',
        wechatTemplateId: 'live',
        groupContent: 'record_only',
      },
      wiring: spec.wiring,
      pendingReason: spec.pendingReason,
      consumedBy: spec.consumedBy,
      note: spec.note,
      canEnable: blockers.length === 0,
      blockers,
      updatedBy: row?.updatedBy ?? null,
      updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    };
  }
}
