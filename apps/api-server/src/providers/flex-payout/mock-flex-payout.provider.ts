import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';

import {
  FlexPayoutProvider,
  PayoutBatch,
  PayoutBatchStatus,
  PayoutRecord,
} from './flex-payout.provider';

/**
 * 灵活用工通道 · 本地假实现
 *
 * 走「一期人工通道（FLEX_MANUAL）」语义：
 *   生成批次 → 导出 CSV → 提交 → 查询结果，全程无外部调用。
 * 个税按**简易占位税率**估算（真实税率以平台规则为准，见合规清单待确认项）。
 */
@Injectable()
export class MockFlexPayoutProvider extends FlexPayoutProvider {
  private readonly logger = new Logger('FlexPayout:mock');
  private readonly batches = new Map<string, PayoutBatch>();

  constructor(private readonly config: ConfigService) {
    super();
  }

  get isMock(): boolean {
    return true;
  }

  async createBatch(records: PayoutRecord[]): Promise<PayoutBatch> {
    const period = records[0]?.settlementDate ?? new Date().toISOString().slice(0, 10);
    const batchNo = this.buildBatchNo(period);
    const totalGross = this.round2(records.reduce((s, r) => s + r.grossAmount, 0));
    const totalTax = this.round2(records.reduce((s, r) => s + r.taxWithheld, 0));
    const totalNet = this.round2(records.reduce((s, r) => s + r.netAmount, 0));

    const batch: PayoutBatch = {
      batchNo,
      periodStart: period,
      periodEnd: period,
      totalGross,
      totalTax,
      totalNet,
      recordCount: records.length,
      records,
    };
    this.batches.set(batchNo, batch);
    this.logger.log(
      `[mock] 生成代发批次 ${batchNo}：${records.length} 人，应发 ¥${totalGross}，代扣税 ¥${totalTax}，实发 ¥${totalNet}`,
    );
    return batch;
  }

  exportCsv(batch: PayoutBatch): string {
    const header = '姓名,手机号,应发金额,代扣个税,实发金额,结算日期,备注';
    const lines = batch.records.map((r) =>
      [
        r.leaderName,
        r.phone,
        r.grossAmount.toFixed(2),
        r.taxWithheld.toFixed(2),
        r.netAmount.toFixed(2),
        r.settlementDate,
        `团长佣金 批次${batch.batchNo}`,
      ].join(','),
    );
    return [header, ...lines].join('\n');
  }

  async submit(batchNo: string): Promise<{ accepted: boolean; externalNo?: string }> {
    this.logger.log(`[mock] 提交代发批次 ${batchNo} → 平台受理`);
    return { accepted: true, externalNo: `mock_flex_${batchNo}` };
  }

  async query(batchNo: string): Promise<{ status: PayoutBatchStatus; paidAt?: string }> {
    const exists = this.batches.has(batchNo);
    if (!exists) return { status: 'FAILED' };
    return { status: 'PAID', paidAt: new Date().toISOString() };
  }

  private buildBatchNo(period: string): string {
    const seed = `${period}-${Date.now()}`;
    return `PB${period.replace(/-/g, '')}${createHash('md5').update(seed).digest('hex').slice(0, 6).toUpperCase()}`;
  }

  private round2(n: number): number {
    return Math.round(n * 100) / 100;
  }
}
