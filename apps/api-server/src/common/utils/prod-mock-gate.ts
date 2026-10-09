/**
 * 「生产禁 mock」启动硬闸的**判据**（纯函数 · 零 IO）
 *
 * ## 它挡的是什么
 *
 * `PROVIDER_MODE=mock` 在生产**不是**「功能降级」，是**安全模型整体失效**：
 *   · `mock-wx-mini.provider.ts` —— `code=dev:<任意>` 直接映射出 openid，
 *     **任何 code 免密登录任意身份**，且不发任何网络请求；
 *   · 同上 —— 手机号恒 `+86 13800138000`；
 *   · `POST /pay/mock/paid` 是 `@Public()` 免鉴权端点，它唯一的内部防线是
 *     `!this.wxpay.isMock` 抛 `10004` ⇒ **mock 下 `isMock === true`，防线不存在**
 *     ⇒ 任意订单可被免鉴权标记为已支付。
 * 而这三件事在**运行期几乎毫无症状**：服务照常起、接口照常通、`/health/ready` 照常绿。
 * （λ-3 起 `/health/ready` **已回显** `providerMode` / `mockEscaped`，运行期**可查**了 ——
 *   但那只是「形态能被问到」，它不拦任何一次免密登录或免鉴权改支付状态 ⇒ 本闸照旧要硬。）
 *
 * ⇒ 故判为「**宁可起不来**」：生产 + mock ⇒ `process.exit(1)`。
 *
 * ## 为什么判据要抽成纯函数（与 `scripts/lib/frozen-sync-rules.mjs` 同构）
 *
 * 判据一旦嵌在 `bootstrap()` 里，就只能靠「真起一次服务」来验证 ——
 * 那需要 DB / 端口 / 完整 DI，等于判据基本没被验过。抽成纯函数后，
 * `scripts/probes/prod-mock-gate.mjs` 能在**毫秒级**跑完四场景与反证，
 * 且测的就是**生产真正执行的那一份**（不是复刻）。
 *
 * ## ⚠️ 两条不许折的口径
 *
 *   1. `providerMode` 必须由调用方传**配置里生效的那个值**
 *      （`cfg.get('app.drivers.providerMode')`），**不要**在这里回退去读
 *      `process.env.PROVIDER_MODE` —— `app.config.ts` 的生产默认值是 `'real'`，
 *      重读 env 会把「漏配时的默认值分岔」绕过去 ⇒ 闸形同虚设。
 *   2. 逃生开关 `ALLOW_MOCK_IN_PROD` **只认 `1` / `true`**（大小写不敏感）。
 *      `0` / `false` / `yes` / 空串 / 随便塞的值 ⇒ **一律视为未开**。
 *      理由与 `main.ts` 的 `REQUIRED_IN_PROD` 注释同源：
 *      「误判没配就退出，会让运维学会随便塞个值绕过」—— 反过来也一样，
 *      开关一旦认任意非空串，就等于没有开关。
 */

/** 逃生开关的取值域 —— 只有这两个算「开了」 */
const ESCAPE_ON = new Set(['1', 'true']);

/** 判据入参（调用方负责把「生效值」取好再喂进来） */
export interface ProdMockGateInput {
  /** `process.env.NODE_ENV` */
  nodeEnv?: string;
  /** **配置里生效的** providerMode（`cfg.get('app.drivers.providerMode')`） */
  providerMode?: string;
  /** 逃生开关的**原始串**（`process.env.ALLOW_MOCK_IN_PROD`） */
  allowMockInProd?: string;
}

export interface ProdMockGateVerdict {
  /** false ⇒ 调用方必须 `Logger.error(reason)` + `process.exit(1)` */
  allow: boolean;
  /** 拒绝理由（`allow === false` 时非空）。含可辨识的判据串 `PROD_MOCK_GATE` */
  reason: string | null;
  /** 逃生开关是否**真的**开了（调用方须以此决定要不要打那条 error） */
  escapeOn: boolean;
  /** `escapeOn` 时必须打出来的告警文案（三件事：现状 / 意味着什么 / 怎么关） */
  notice: string | null;
}

/** 判据串：探针与日志都靠它辨认「这条是硬闸拦的」，不许改名 */
export const PROD_MOCK_GATE_TAG = 'PROD_MOCK_GATE';

/** 逃生开关：只认 `1` / `true`（trim + 大小写不敏感），其余一律未开 */
export function isEscapeOn(raw?: string): boolean {
  return ESCAPE_ON.has((raw ?? '').trim().toLowerCase());
}

/**
 * 判据：生产 + mock ⇒ 拒绝启动（除非逃生开关真的开了）
 *
 * @param input 见 `ProdMockGateInput`
 */
export function judgeProdMock(input: ProdMockGateInput = {}): ProdMockGateVerdict {
  if ((input.nodeEnv ?? '').trim() !== 'production') {
    // 非生产：mock 是**依赖**（本地开发与 e2e 全链路都靠它），本闸不介入
    return { allow: true, reason: null, escapeOn: false, notice: null };
  }

  const mode = (input.providerMode ?? '').trim().toLowerCase();
  if (mode !== 'mock') return { allow: true, reason: null, escapeOn: false, notice: null };

  const escapeOn = isEscapeOn(input.allowMockInProd);
  if (escapeOn) {
    return {
      allow: true,
      reason: null,
      escapeOn: true,
      notice:
        `${PROD_MOCK_GATE_TAG} 逃生开关已开启，服务**正在以不安全形态运行**：` +
        '当前 NODE_ENV=production 且 PROVIDER_MODE=mock ⇒ ' +
        '① `code=dev:<任意>` 可**免密登录任意身份**（不发任何网络请求）；' +
        '② 免鉴权端点 `POST /pay/mock/paid` 的唯一防线 `!isMock` 在 mock 下**恒不成立**' +
        ' ⇒ 任意订单可被任意人标记为已支付；③ 手机号恒为 +86 13800138000。' +
        '怎么关：把 .env 的 `PROVIDER_MODE` 改成 `real`（并配齐微信 / 支付账号）后重启，' +
        '并**删掉 `ALLOW_MOCK_IN_PROD`**（留 `0` / `false` 也算没开，但显式删掉最不容易误会）。',
    };
  }

  return {
    allow: false,
    escapeOn: false,
    notice: null,
    reason:
      `${PROD_MOCK_GATE_TAG} 启动中止：NODE_ENV=production 且生效的 PROVIDER_MODE=mock。` +
      'mock 在生产不是「功能降级」，而是**免密登录任意身份 + 免鉴权改支付状态**，' +
      '且运行期几乎毫无症状（服务照常起、接口照常通、健康检查照常绿；' +
      'λ-3 起 `/health/ready` 已回显 `providerMode` / `mockEscaped`，运行期可查，' +
      '但那只说明形态可问，它不拦任何一次请求）。宁可起不来，不可带着假安全上线。' +
      '处理：.env 里写 `PROVIDER_MODE=real` 并配齐微信 / 支付账号后重启；' +
      '确需在产物跑 mock，请显式设 `ALLOW_MOCK_IN_PROD=1`' +
      '（只认 `1` / `true`；`0` / `false` / `yes` / 空串一律视为未开）。',
  };
}
