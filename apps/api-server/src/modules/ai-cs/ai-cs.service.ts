import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { SysConfig } from '../../database/entities/system.entity';
import {
  answerQuestion,
  buildComplianceBlock,
  type ComplianceBlock,
  type ComplianceData,
  type CsAnswer,
} from '../../common/utils/ai-cs';

/**
 * C 端智能客服（D · #44）
 *
 * 职责极薄：读配置（124 号令公示所需的公司级备案信息）→ 构造公示块 →
 * 调纯函数 `answerQuestion` 做规则命中问答。本服务**不接 LLM**（生产 `PROVIDER_MODE=mock`），
 * 所有答案来自 `common/utils/ai-cs.ts` 的罐头 FAQ。
 *
 * 公示数据来源：`ab_config` 中 `compliance.*` 一组键（新增于 `config.specs.ts`，
 * 运营可在后台「系统配置」页直接编辑；缺省走代码兜底值）。
 */
@Injectable()
export class AiCsService {
  private readonly logger = new Logger(AiCsService.name);

  constructor(private readonly dataSource: DataSource) {}

  /** 读单条配置，库无此行时回退到 fallback */
  private async configValue(key: string, fallback: string): Promise<string> {
    const row = await this.dataSource
      .getRepository(SysConfig)
      .findOne({ where: { configKey: key } });
    return row?.configValue && row.configValue.length > 0 ? row.configValue : fallback;
  }

  /** 组装 124 号令公示块（公司级备案信息 + 标签字段 schema） */
  async getComplianceBlock(): Promise<ComplianceBlock> {
    const data: ComplianceData = {
      subjectName: await this.configValue('compliance.subjectName', '北京巡礼之年科技有限公司'),
      businessAddress: await this.configValue('compliance.businessAddress', ''),
      filingNo: await this.configValue('compliance.filingNo', ''),
      creditCode: await this.configValue('compliance.creditCode', ''),
      businessScope: await this.configValue(
        'compliance.businessScope',
        '食品销售（仅销售预包装食品）',
      ),
      filingDate: await this.configValue('compliance.filingDate', ''),
    };
    return buildComplianceBlock(data);
  }

  /** 消费者提问 → 规则命中答案（相关话题自动挂载公示块） */
  async ask(question: string): Promise<CsAnswer> {
    const block = await this.getComplianceBlock();
    return answerQuestion(question, block);
  }
}
