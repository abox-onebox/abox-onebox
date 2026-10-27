/**
 * 缺键 WARN 长什么样（只读 · 不改业务数据）
 *
 * 用途：后端说部署后会看到 5 条 `[BizConfig] ab_config 缺键 … → 回落缺省 N`。
 *   但它们是**惰性的**：每进程每键**只在第一次被读到时**才打一条。
 *   `suspend_force_max_count` 要管理员真的去停用楼宇才读，`pay_timeout_minutes`
 *   要创建订单才读 —— 冒烟脚本**不写业务数据**，所以冒烟跑完看不到它们是正常的，
 *   **不能据此判断修复没生效**。
 *
 * 本脚本用**容器里正在跑的那份 dist**、配真实 Logger，把那条 WARN **原样打出来**，
 * 好让值班的人见到它时认得：这是修复生效的标志，不是新报错。
 *
 * 用法：cat scripts/probes/cfgwarn-demo.cjs | docker exec -i abox-api-prod node
 */
const path = '/app/apps/api-server/dist/common/services/biz-config.service.js';
const m = require(path);
const { Logger } = require('@nestjs/common');

// ⚠️ 这里喂的是**空表**，所以它打出来的是「全缺键」的**最坏情况**，
//    **不等于现网会打几条**。真实条数要看 `ab_config` 里到底缺哪几个键：
//    现网（2026-10-27 核）缺的是 5 个：`building.suspend_force_max_count`、
//    `order.pay_timeout_minutes`、`commission.withdraw_daily_limit`、
//    `commission.withdraw_daily_count`、`settlement.supplier_total_default`；
//    而 `settlement.site_fee` / `packing_labor_fee` / `delivery_fee` 库里**有值（0.00）**，
//    不会打 WARN —— 我第一次就是用了空表多报了这 3 条，属于**演示输入不等于现网**，
//    以此为戒：演示脚本必须在代码里写清「喂的是什么」。
//    要看现网真实条数就给环境变量传真实行（同 `cfgprobe.cjs` 的 ABOX_CFG_ROWS）。
const rows = process.env.ABOX_CFG_ROWS ? JSON.parse(process.env.ABOX_CFG_ROWS) : [];
const svc = new m.BizConfigService({ getRepository: () => ({ find: async () => rows }) }, {});
svc.logger = new Logger('BizConfig'); // 用真 Logger，拿到与现网逐字一致的输出

(async () => {
  await svc.suspendForceMaxCount();
  await svc.payTimeoutMinutes();
  await svc.withdrawDailyLimit();
  await svc.withdrawDailyCount();
  await svc.settlementCostItems();
})().catch((e) => {
  console.error('PROBE FAILED', e);
  process.exit(1);
});
