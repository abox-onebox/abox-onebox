/**
 * 灵活用工平台出款通道抽象（团长佣金代发 + 代扣个税 · C11）
 *
 * 业务背景（C11 裁决）：
 *   团长佣金**不由平台自己发放**，而是委托灵活用工平台代发，个税由平台代扣代缴，
 *   团长到手即为税后金额；平台按流水支付服务费（通常 6%–8%）。
 *   供应商 / 集散中心走人工对公转账日结，**不在本通道范围内**。
 *
 * 通道形态：
 *   FLEX_MANUAL —— 一期：系统生成代发清单（CSV）→ 人工上传至平台后台 → 回执登记
 *   FLEX_API    —— 二期：对接平台打款 API，自动提交与回执
 */
export const FLEX_PAYOUT_PROVIDER = Symbol('FLEX_PAYOUT_PROVIDER');

export interface PayoutRecord {
  /** 团长 ID */
  leaderId: number;
  leaderName: string;
  /** 收款手机号（灵活用工平台以此识别收款人） */
  phone: string;
  /** 应发佣金（元，税前） */
  grossAmount: number;
  /** 代扣个税（元） */
  taxWithheld: number;
  /** 实发（元，= gross - tax） */
  netAmount: number;
  /** 结算周期归属（如 2026-09-14） */
  settlementDate: string;
}

export interface PayoutBatch {
  batchNo: string;
  periodStart: string;
  periodEnd: string;
  totalGross: number;
  totalTax: number;
  totalNet: number;
  recordCount: number;
  records: PayoutRecord[];
}

export type PayoutBatchStatus = 'CREATED' | 'EXPORTED' | 'SUBMITTED' | 'PAID' | 'FAILED';

export abstract class FlexPayoutProvider {
  abstract get isMock(): boolean;

  /** 生成代发批次（清单） */
  abstract createBatch(records: PayoutRecord[]): Promise<PayoutBatch>;

  /** 导出平台可识别的 CSV 清单（一期走人工上传） */
  abstract exportCsv(batch: PayoutBatch): string;

  /** 提交批次（二期 API 通道使用；一期为空实现） */
  abstract submit(batchNo: string): Promise<{ accepted: boolean; externalNo?: string }>;

  /** 查询批次结果 */
  abstract query(batchNo: string): Promise<{ status: PayoutBatchStatus; paidAt?: string }>;
}
