/**
 * ab_config 实读探针（只读 · 不改业务数据）
 *
 * 用途：在**运行中的 api 容器**里，用**真实编译产物**读一次业务配置 getter，
 * 证明「缺键时回落的是缺省值，而不是 0」。
 *
 * 用法（服务器 /opt/abox-onebox）：
 *   cat scripts/probes/cfgprobe.cjs | docker exec -i abox-api-prod node
 *
 * 为什么不直接查库了事：查库只能证明「键缺失」，证明不了「代码读到缺失时给什么」。
 * 这个探针喂进去的是**真实 DB 行**（下方 rows 由 mysql 直查结果填入），
 * 走的是容器里正在跑的那份 dist —— 所以它读出来的就是线上真实生效值。
 */
const path = '/app/apps/api-server/dist/common/services/biz-config.service.js';
const m = require(path);
const { pickConfigNumber } = require('/app/apps/api-server/dist/common/utils/config-value.js');

// 现网 ab_config 的行。**必须由调用方用环境变量喂真实行**，不许用写死的快照糊弄：
//   ABOX_CFG_ROWS='[{"configKey":"...","configValue":"..."}]' ... docker exec -i abox-api-prod node
// 不传时下面这份只是「空表」兜底（会把所有键都当缺键 ⇒ 全走 fallback），
// 它**不代表现网**，仅用于看纯 fallback 行为。
const DEFAULT_ROWS = [];
const rows = process.env.ABOX_CFG_ROWS ? JSON.parse(process.env.ABOX_CFG_ROWS) : DEFAULT_ROWS;
if (rows.length === 0) {
  console.log('WARN  注入行数为 0 ⇒ 每行都会走 fallback，结果不等于现网（真实行数应由调用方注入）');
}
const ds = { getRepository: () => ({ find: async () => rows }) };
const svc = new m.BizConfigService(ds, {});
const noop = () => {};
svc.logger = { warn: noop, log: noop, error: noop, debug: noop, verbose: noop };
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));

(async () => {
  const items = [
    ['building.suspend_force_max_count', () => svc.suspendForceMaxCount(), 20],
    ['order.pay_timeout_minutes', () => svc.payTimeoutMinutes(), 30],
    ['commission.withdraw_daily_limit', () => svc.withdrawDailyLimit(), 2000],
    ['commission.withdraw_daily_count', () => svc.withdrawDailyCount(), 1],
    // ⚠️ 缺省 0 = 「不限起提」（D3 定稿 2026-10-26 用户拍板）。
    //    2026-10-27 之前这里是 10，改过一次方向；改回 0 是有依据的，别再拿旧值当期望。
    ['commission.min_withdraw', () => svc.minWithdraw(), 0],
  ];
  console.log(pad('键', 38) + pad('旧实现(缺键)', 16) + pad('新实现(现网实读)', 20) + pad('缺省', 8) + '判定');
  for (const [k, fn, fb] of items) {
    const raw = rows.find((r) => r.configKey === k)?.configValue ?? null;
    const oldImpl = Number.isFinite(Number(raw)) ? Number(raw) : fb;
    const now = await fn();
    console.log(pad(k, 38) + pad(oldImpl, 16) + pad(now, 20) + pad(fb, 8) + (now === fb ? '已修复' : '不符预期'));
  }
  const st = await svc.settlementCostItems();
  console.log('');
  console.log('settlement.supplier_total_default 现网实读 = ' + st.supplierTotal + '（旧实现缺键=0，缺省=14）');
  console.log('');
  console.log(
    '纯函数边界: null=>' +
      pickConfigNumber(null, 20) +
      ' 空串=>' +
      pickConfigNumber('', 20) +
      ' 纯空白=>' +
      pickConfigNumber('   ', 20) +
      " 显式'0'=>" +
      pickConfigNumber('0', 20) +
      '（显式 0 仍被尊重，不是「没配」）',
  );
  console.log('dist 路径: ' + path);
})().catch((e) => {
  console.error('PROBE FAILED', e);
  process.exit(1);
});
