/**
 * api/compliance —— 124 号令资质与标签公示（免登录 · 公开只读）
 *
 * 后端 `GET /api/v1/ai-cs/compliance/124` 带 `@Public()`，不需要登录态。
 * 字段来自后台「系统配置 · 124 号令合规公示」一组键，运营可编辑；
 * ⚠️ 端上**不硬编码**任何工商 / 备案信息，否则备案编号补录后必须重新发版。
 *
 * 依据：124 号令第二十条 —— 店铺主页显著位置持续公示备案信息，
 * 且销售食品主页面须展示预包装食品标签信息（常驻义务，不是提审贴一次）。
 */
import { http } from './request';

/** 公司级备案信息（后台配置下发，缺省为空串而非伪造值） */
export interface ComplianceFiling {
  /** 经营主体名称 */
  subjectName: string;
  /** 仅销售预包装食品备案编号；未补录时为空串 */
  filingNo: string;
  /** 统一社会信用代码 */
  creditCode: string;
  /** 经营范围 */
  businessScope: string;
  /** 备案日期（YYYY-MM-DD） */
  filingDate: string;
}

/** 公示块：与后端 `ComplianceBlock`（common/utils/ai-cs.ts）同构 */
export interface ComplianceBlock {
  title: string;
  filing: ComplianceFiling;
  /** 预包装食品标签必含字段名（GB 7718 核心项），逐单品具体值以实物标签为准 */
  labelFields: string[];
  note: string;
}

/**
 * 读取公示块。
 *
 * `keepAuthState: true` 语义见 `api/request.ts`：本接口是**公开只读信息**，
 * 无权裁决登录态是否有效 —— 不能因为一次公示请求失败就触发重登 / 清 session。
 *
 * ⚠️ 调用点**仍需**显式传 `{ keepAuthState: true }`：`mp:no-bare-call` 是静态闸门，
 *    只认页面调用点括号里的 flag，看不见 `api/` 定义层。这里再兜一个默认值，
 *    两处都挂 ⇒ 既过闸门，也不怕后来人漏传（P1-16：裸调会清掉重登写入的新 token）。
 */
export function fetchCompliance124(
  options: { keepAuthState?: boolean } = {},
): Promise<ComplianceBlock> {
  return http.get<ComplianceBlock>('/ai-cs/compliance/124', {
    keepAuthState: true,
    ...options,
  });
}
