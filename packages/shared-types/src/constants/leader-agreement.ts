/**
 * 《团长合作协议》版本号 —— **跨端唯一真源**
 *
 * ## 为什么非得有这一个常量
 *
 * 2026-10-08 之前，同一个版本号在**三处各写一份**，而且互相打架：
 *
 * | 位置 | 值 | 后果 |
 * |---|---|---|
 * | 小程序申请页 `pages/leader-apply/leader-apply.vue` | `v1.0` | 新团长申请时签的是 v1.0 |
 * | 小程序资料页 `pages/leader/profile.vue` | `v1.1` | 同一个团长进资料页就被提示「重新签署 v1.1」 |
 * | 服务端后台任命 `modules/team-leader/leader-admin.service.ts` | `v1.0` | 第三条路又签回 v1.0 |
 * | 后台 audit 表单 `admin-web/src/views/leader/list.vue` | `v1.0` | 第四份，且加了白名单后会带着过期默认值去请求 |
 *
 * ⇒ 同一位团长的签署留痕在几分钟内走过 `v1.0 → v1.1`；而服务端**当时没有任何校验**，
 *    `agree_version` 实质上由客户端随意写入。`agree_version` 是举证「他签过哪一版」的
 *    唯一凭据（配 `agreed_at` 构成完整留痕）—— 一旦可被随意填写，它在争议时就失去证明力。
 *
 * ⭐ 裁定（2026-10-08）：① 四处统一引用本常量；② 服务端入口加白名单（`@IsIn`），
 *    未知版本号一律拒、不再静默入库。
 *
 * ## ⚠️ 升版怎么做（三步，别只做一半）
 *
 *   ① 把**旧值挪进** `LEADER_AGREEMENT_HISTORY_VERSIONS` —— 不挪的话，后台就再也无法
 *      为老团长做**历史补签**：有些团长当年签的确实是旧版本，留痕必须如实写旧值，
 *      否则这份凭据反而失真。服务端 `sign_agreement` 的原始用途就是
 *      「协议升级重签 / **历史补签**」，这条路不能被升版堵死。
 *   ② 把 `LEADER_AGREEMENT_VERSION` 改成新版本值（UI 默认值会自动跟到新版）。
 *   ③ `scripts/e2e-m2.mjs` / `scripts/e2e-m3.mjs` 里有镜像的字面量 —— `.mjs` 不能
 *      import TS 真源，改值时必须同步，那两处已就地写了提示注释。
 */
/** 当前生效的版本号 —— UI 默认值、客户端签署时用 */
export const LEADER_AGREEMENT_VERSION = 'v1.0';

/**
 * 已发布过、但**不再是当前版本**的历史版本号
 *
 * ⚠️ 留它不是为了怀旧，是为了让后台**历史补签**还能如实落旧的那一版。
 *    详见本文件头注「升版怎么做」第 ① 步。
 */
export const LEADER_AGREEMENT_HISTORY_VERSIONS: readonly string[] = [];

/**
 * 合法版本号白名单 —— 服务端 `@IsIn` 校验用
 *
 * = 历史版本 + 当前版本
 *
 * ⚠️ 这是**写入侧**校验：只管「这次签的是哪一版」，不约束库里的历史值
 *    （读侧一律原样下发、不做过滤）。
 */
export const LEADER_AGREEMENT_VERSIONS: readonly string[] = [
  ...LEADER_AGREEMENT_HISTORY_VERSIONS,
  LEADER_AGREEMENT_VERSION,
];

/**
 * 校验失败时给用户的合法值提示
 *
 * 三处 DTO 共用一个字符串 —— 各自拼一遍迟早拼出三种说法。
 */
export const LEADER_AGREEMENT_VERSIONS_TEXT: string = LEADER_AGREEMENT_VERSIONS.join(' / ');
