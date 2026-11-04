import { http } from './request';

/** C 端智能客服（D · #44）：预览用类型，与后端 `common/utils/ai-cs.ts` 对齐 */

/** 124 号令公示块：公司级备案信息 + 预包装标签必含字段 */
export interface ComplianceFiling {
  subjectName: string;
  filingNo: string;
  creditCode: string;
  businessScope: string;
  filingDate: string;
}

export interface ComplianceBlock {
  title: string;
  filing: ComplianceFiling;
  labelFields: string[];
  note: string;
}

export type CsIntent =
  'order' | 'delivery' | 'refund' | 'meal' | 'qualification' | 'label' | 'contact' | 'other';

export interface CsAnswer {
  intent: CsIntent;
  answer: string;
  compliance: ComplianceBlock | null;
  matched: boolean;
}

/** 124 号令资质与标签公示（只读预览，等同消费者端可见内容） */
export function getCompliance124(): Promise<ComplianceBlock> {
  return http.get('/ai-cs/compliance/124');
}

/** 消费者提问（规则命中问答；命中资质/标签类话题会挂载公示块） */
export function askCs(question: string): Promise<CsAnswer> {
  return http.post('/ai-cs/ask', { question });
}
