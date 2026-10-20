// 机械复核：协议正文（agreements.ts）改动是否真落盘是否真落盘（断言 + 计次，失败非零退出）
import { readFileSync } from 'node:fs';

const P = new URL('../../apps/miniprogram/src/constants/agreements.ts', import.meta.url);
const s = readFileSync(P, 'utf8');
const lines = s.split(/\r?\n/);

const count = (needle) => s.split(needle).length - 1;
/** 只数「正文行」（缩进后以单引号开头的字符串字面量）里的出现次数 */
const bodyCount = (needle) =>
  lines.filter((l) => l.trimStart().startsWith("'") && l.includes(needle)).length;
const lineHas = (prefix, needle) => lines.some((l) => l.includes(prefix) && l.includes(needle));

const checks = [
  ['A1 截单行加了「以页面为准」', lineHas('下单规则', '具体时刻以小程序下单页实时展示为准')],
  ['A2 截单行保留 24:00', lineHas('下单规则', '24:00')],
  ['A3 送达行加了「以页面为准」', lineHas('送达时间', '具体时刻以小程序下单页实时展示为准')],
  ['A4 送达行保留 11:30', lineHas('送达时间', '11:30')],
  // ⚠️ 只数**正文行**（trimStart 后以单引号开头的字符串字面量行）；注释里引用同一措辞不算
  ['A5 尾巴在正文出现恰好 2 次', bodyCount('具体时刻以小程序下单页实时展示为准') === 2],
  ['A6 联系我们行改为「联系客服」', lineHas('如你对本政策有任何疑问', '我的 → 联系客服')],
  ['A7 联系我们行已无「客服微信号」', !lineHas('如你对本政策有任何疑问', '客服微信号')],
  ['A8 旧更新日期已消失', count("updatedAt: '2026-09-20'") === 0],
  // ⚠️ 2026-10-20 U15：隐私政策正文加埋点三条款 ⇒ updatedAt 分流：
  //    用户协议仍 2026-10-07（未动），隐私政策改为 2026-10-20。
  [
    'A9 更新日期：用户协议 2026-10-07 ×1 + 隐私政策 2026-10-20 ×1',
    count("updatedAt: '2026-10-07'") === 1 && count("updatedAt: '2026-10-20'") === 1,
  ],
  // U15 埋点三条款（2026-10-20 新增；改口径时同步改这里）
  ['A12 收集条款含匿名口径', bodyCount('页面访问记录（匿名）') === 1],
  ['A13 使用条款限聚合统计', bodyCount('仅用于聚合统计分析') === 1],
  ['A14 留存条款写 180 天', bodyCount('保留 180 天') === 1],
  ['A10 文件头口径已改', s.includes('正文里只说「我的 → 联系客服」')],
  ['A11 裁定说明已落', s.includes('2026-10-07 主理人裁定')],
];

let bad = 0;
for (const [name, okv] of checks) {
  if (!okv) bad++;
  console.log(`${okv ? 'PASS' : 'FAIL'}  ${name}`);
}
console.log(`\n正文行含「客服微信号」次数 = ${bodyCount('客服微信号')}（应为 0）`);
if (bodyCount('客服微信号') !== 0) bad++;
console.log(bad === 0 ? 'ALL PASS' : `FAILED ${bad}`);
process.exit(bad === 0 ? 0 : 1);
