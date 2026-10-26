/**
 * suspend-guard —— N2 闸门在后台的落地（《ADR-N1N2W1》§7 / P3-5）
 *
 * 形态：**错误驱动二次确认**。常态表单里不放「强制停用」勾选框 ——
 * 绝大多数的楼没有未完结订单，常驻控件只会污染常态；只有真被拦下才弹确认、才收集理由。
 *
 * ⚠️ 四条**互不通融**的分支，禁止合并成一句兜底文案：
 *
 * | 码 | 处置 | 是否给强制入口 |
 * |---|---|---|
 * | 60006 / 60007 | 影响摘要 + 收集原因后重提交 | 是 |
 * | 60013 | 履约阶段不可撤回，逐单走退款审批 | 否（硬约束） |
 * | 60012 | 超阈值，走两级审批 | 否（force 也无效） |
 * | 10001 | 命中 - 原因不足 10 字，就地提示字数下限 | 重填 |
 *
 * 之所以必须分开：这四类运营该做的动作完全不同 —— 填原因 / 找配送 / 找审批人 / 重填。
 * 合成「操作失败，请重试」等于把判断成本推给运营。
 *
 * ⚠️ `hint` 一律**原样渲染**：服务端已按「卡退款审批」「待履约」「不可撤回」分套措辞，
 *    端上自己组织词就是第二份中文。这里只用 `h()` 拼 VNode，不用 `dangerouslyUseHTMLString`
 *    —— payload 里的 `orderNos` 等来自服务端，走 HTML 字符串等于给注入开口子。
 */
import { ElMessage, ElMessageBox } from 'element-plus';
import { h } from 'vue';

import type {
  SuspendIrrevocablePayload,
  SuspendRequireApprovalPayload,
  UnfinishedOrdersPayload,
} from '@/api/building';
import { ApiError } from '@/api/request';

/** 强制停用原因的字数下限（与后端 DTO `@MinLength(10)` 同源，改一处要两处同步）*/
export const SUSPEND_REASON_MIN = 10;

const CODE_BUILDING_UNFINISHED = 60006;
const CODE_GROUP_UNFINISHED = 60007;
const CODE_REQUIRE_APPROVAL = 60012;
const CODE_IRREVOCABLE = 60013;
/** 格式校验被全局 ValidationPipe 拒 —— 只在**重提交**路径上出现才代表原因不达字数 */
const CODE_PARAM_INVALID = 10001;

/** 摘要最多展示几条订单样例 */
const SAMPLE_LIMIT = 5;

interface ForceSuspendArgs {
  forceSuspend: true;
  suspendReason: string;
}

// ---------------------------------------------------------------------------
// VNode 拼装
// ---------------------------------------------------------------------------

/** 缺字段时显示占位 —— 宁可显示「—」，也不要渲染出 `undefined` */
const fmt = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : String(v));

const LINE = 'font-size:13px;line-height:1.8;';
const MUTED = 'color:var(--el-text-color-secondary);';

/** 服务端 `hint` 原样展示（不改写、不补全、不加自己的措辞）*/
const hintBlock = (hint?: string) =>
  h(
    'p',
    {
      style:
        'margin:10px 0 0;padding:8px 10px;border-left:2px solid var(--el-color-warning);' +
        `${MUTED}font-size:13px;line-height:1.6;white-space:pre-wrap;`,
    },
    fmt(hint),
  );

const orderNoList = (orderNos?: string[]) => {
  const nos = orderNos?.filter(Boolean).slice(0, SAMPLE_LIMIT) ?? [];
  if (!nos.length) return null;
  return h(
    'ul',
    { style: `margin:4px 0 0;padding-left:18px;${MUTED}` },
    nos.map((no) => h('li', null, no)),
  );
};

function unfinishedBody(p: UnfinishedOrdersPayload | undefined) {
  const rows = [
    h(
      'div',
      null,
      `未完结订单 ${fmt(p?.unfinishedCount)} 笔（可强制上限 ${fmt(p?.threshold)} 笔）`,
    ),
    h('div', null, `最早出餐日 ${fmt(p?.earliestMealDate)}`),
    h(
      'div',
      null,
      `其中履约阶段 ${fmt(p?.groupA?.count)} 笔、其余未完结 ${fmt(p?.groupB?.count)} 笔`,
    ),
  ];

  const samples = p?.samples?.slice(0, SAMPLE_LIMIT) ?? [];
  if (samples.length) {
    rows.push(h('div', { style: `margin-top:6px;${MUTED}` }, '部分订单：'));
    rows.push(
      h(
        'ul',
        { style: `margin:4px 0 0;padding-left:18px;${MUTED}` },
        samples.map((s) =>
          h('li', null, `${fmt(s.orderNo)} · ${fmt(s.mealDate)} · ${fmt(s.statusLabel)}`),
        ),
      ),
    );
  }

  return h('div', { style: LINE }, [...rows, hintBlock(p?.hint)]);
}

function requireApprovalBody(p: SuspendRequireApprovalPayload | undefined) {
  return h('div', { style: LINE }, [
    h('div', null, `未完结订单 ${fmt(p?.unfinishedCount)} 笔`),
    h('div', null, `可强制停用上限 ${fmt(p?.threshold)} 笔`),
    h('div', null, `审批事项 ${fmt(p?.opCode)}`),
    hintBlock(p?.hint),
  ]);
}

function irrevocableBody(p: SuspendIrrevocablePayload | undefined) {
  return h('div', { style: LINE }, [
    h('div', null, `履约阶段订单 ${fmt(p?.groupA?.count)} 笔`),
    orderNoList(p?.groupA?.orderNos),
    hintBlock(p?.hint),
  ]);
}

// ---------------------------------------------------------------------------
// 分支
// ---------------------------------------------------------------------------

/** 60006 / 60007 —— 读完影响摘要后收集原因，重提交 */
async function flowForceSuspend(
  p: UnfinishedOrdersPayload | undefined,
  retry: (force: ForceSuspendArgs) => Promise<void>,
): Promise<boolean> {
  let reason: string;
  try {
    const { value } = await ElMessageBox.prompt(unfinishedBody(p), '停用被拦下：仍有未完结订单', {
      type: 'warning',
      confirmButtonText: `确认强制停用（需填原因 ≥ ${SUSPEND_REASON_MIN} 字）`,
      cancelButtonText: '取消停用',
      inputType: 'textarea',
      inputPlaceholder: `为什么必须停用？不少于 ${SUSPEND_REASON_MIN} 字，将记入操作日志`,
      inputValidator: (v: string) => {
        const n = v.trim().length;
        return n >= SUSPEND_REASON_MIN || `原因不足 ${SUSPEND_REASON_MIN} 字（当前 ${n} 字）`;
      },
    });
    reason = value.trim();
  } catch {
    // 用户点了「取消停用」或校验未过 → 什么都不做，退回编辑弹窗
    return true;
  }

  try {
    await retry({ forceSuspend: true, suspendReason: reason });
    return true;
  } catch (err) {
    // 只有**这条重提交路径**上的 10001 才说明原因不达字数
    if (err instanceof ApiError && err.code === CODE_PARAM_INVALID) {
      ElMessage.warning(`原因未通过校验：不少于 ${SUSPEND_REASON_MIN} 字，请写清缘由后重试。`);
      return true;
    }
    return false;
  }
}

/** 60012 —— force 也无效，只能走审批 */
async function alertRequireApproval(p: SuspendRequireApprovalPayload | undefined) {
  try {
    await ElMessageBox.alert(requireApprovalBody(p), '无法强制停用：超出阈值', {
      type: 'error',
      confirmButtonText: '我知道了',
    });
  } catch {
    // alert 只有「我知道了」，关闭即忽略
  }
  return true;
}

/** 60013 —— 硬约束，运营无权撤回 */
async function alertIrrevocable(p: SuspendIrrevocablePayload | undefined) {
  try {
    await ElMessageBox.alert(irrevocableBody(p), '无法停用：已有订单进入履约阶段', {
      type: 'error',
      confirmButtonText: '我知道了',
    });
  } catch {
    // 同上
  }
  return true;
}

/**
 * 处理保存失败时的 N2 闸门分支
 *
 * @param e      保存抛出的错误
 * @param retry  带上 `forceSuspend` / `suspendReason` 重新提交
 * @returns      `true` = 已按分支处理（含用户取消），调用方**不要**再弹通用错误；
 *               `false` = 与本闸门无关或重提交时又失败了，交给调用方兜底
 */
export async function guardSuspendWrite(
  e: unknown,
  retry: (force: ForceSuspendArgs) => Promise<void>,
): Promise<boolean> {
  if (!(e instanceof ApiError)) return false;

  switch (e.code) {
    case CODE_BUILDING_UNFINISHED:
    case CODE_GROUP_UNFINISHED:
      return await flowForceSuspend(e.data as UnfinishedOrdersPayload | undefined, retry);
    case CODE_REQUIRE_APPROVAL:
      return await alertRequireApproval(e.data as SuspendRequireApprovalPayload | undefined);
    case CODE_IRREVOCABLE:
      return await alertIrrevocable(e.data as SuspendIrrevocablePayload | undefined);
    default:
      return false;
  }
}
