import { Controller, Get, HttpStatus, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { ErrorCode } from '../common/constants/error-code';
import { Public } from '../common/decorators/auth.decorator';
import { BizException } from '../common/exceptions/biz.exception';
import { QueueService } from '../common/queue/queue.service';
import { QUEUE_LABEL, QUEUE_NAMES } from '../common/queue/queue.types';

/**
 * 探针单次超时（ms）
 *
 * ⚠️ 探针自身不能成为故障点：依赖「半死」（TCP 连上但不回包）时，没有超时的
 *    探针会一直挂着，编排器的探针请求于是堆积 —— 把「一个依赖慢」放大成
 *    「这实例完全探不动」，最后连日志都刷不出来。
 */
const PROBE_TIMEOUT_MS = 1_500;

/** 原始探测结果 —— `error` **只进日志、不进 HTTP 出参** */
interface RawProbe {
  ok: boolean;
  latencyMs: number;
  error?: string;
}

/**
 * 带超时地跑一次探测，把「抛错」与「超时」统一收敛成 `ok: false`
 *
 * 用 `clearTimeout` 而非 `unref()`：后者依赖 Node 的 Timeout 对象类型，
 * 在本仓 tsconfig 的类型环境下不稳定；`finally` 里清理是等价且更直白的。
 */
async function timedProbe(
  fn: () => Promise<unknown>,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<RawProbe> {
  const t0 = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`探测超时（${timeoutMs}ms）`)), timeoutMs);
      }),
    ]);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: (e as Error).message.slice(0, 300) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 健康探针（M5-0）—— 免鉴权，**两级分开**
 *
 * | 端点 | 语义 | 失败时编排器该做什么 |
 * | --- | --- | --- |
 * | `GET /health` | **存活**（liveness）· 进程还能应答就 ok，**不检依赖** | 重启容器 |
 * | `GET /health/ready` | **就绪**（readiness）· 依赖真能用 + 消费者齐才 ok | **摘流量**，不重启 |
 *
 * ⭐ 为什么必须拆开：若 liveness 也检 DB，则 DB 抖动 → 探针全红 → 编排器重启
 *    所有容器 → 重启期间没人能服务、DB 压力更大 → **重启风暴**。
 *    而 DB 挂了重启应用根本治不好，那是「摘流量 + 告警」要处理的事。
 *
 * ⚠️ `/health` 的**出参契约不可改**：三个 e2e 套件的 `waitHealthy()` 都以
 *    `HTTP 200 && body.code === 0` 判定「服务已起」，改出参等于三套件全红。
 *    新增能力一律走新端点，不要动它。
 *
 * ## ⚠️ 本端点免鉴权，故**出参按「会被人看见」设计**
 *
 * 失败原因（DB 主机、端口、账号、连接串）**只写服务端日志**，HTTP 出参里
 * 一律给固定文案。探针是公网可达的（编排器要打），把底层错误原样回显
 * 等于把内网拓扑放在门口。运维要细节就去翻日志 —— 那一侧有访问控制。
 */
@ApiTags('系统')
@Controller('health')
export class HealthController {
  private readonly logger = new Logger('HealthProbe');

  /** 本实例启动时刻 —— 用于回报 `uptimeSec`（区分「刚重启完」与「已稳定运行」） */
  private readonly bootedAt = Date.now();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly queue: QueueService,
    private readonly cfg: ConfigService,
  ) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '存活探针（免鉴权 · 不检依赖）' })
  check() {
    return { status: 'ok', service: 'abox-api', ts: Date.now() };
  }

  /**
   * 就绪探针 —— 检「数据库连通」与「队列消费者是否齐」
   *
   * ## 为什么检的是「消费者齐不齐」而不是「Redis 通不通」
   *
   * Redis / DB 的**连通性在启动期已经 fail-closed 验过**（`RedisQueueBackend.create`
   * 连不上即拒绝启动，见 `queue.types.ts`）—— 服务能起来，本身就证明启动那一刻是通的。
   *
   * 而「消费者有没有注册上」是**启动期验不到、且失败后完全静默**的一类故障：
   * 注册丢失时入队照常成功、`GET /admin/queue` 计数照常显示，但任务**永远无人消费**。
   * 这正是运维需要探针替他盯住的那件事。
   *
   * 运行中 Redis 失联则表现为入队抛错 + 死信落 `ab_operation_log`（有痕迹、可查），
   * 不靠探针兜。
   */
  @Public()
  @Get('ready')
  @ApiOperation({ summary: '就绪探针（免鉴权 · 检数据库与队列消费者）' })
  async ready() {
    const version = this.cfg.get<string>('app.version') ?? 'dev';

    // DB：真跑一条语句。不用 `isInitialized` —— 连接池里的死连接不会反映在它上面
    const rawDb = await timedProbe(() => this.dataSource.query('SELECT 1'));

    // 队列：不重连、不 PING（探针不产生副作用），只看消费者注册完整度
    const missing = QUEUE_NAMES.filter((q) => !this.queue.hasConsumer(q));
    const stats = await this.queue.stats().catch(() => null);

    const failed: string[] = [];
    if (!rawDb.ok) failed.push('db');
    if (missing.length) failed.push('queue');

    // 原始失败原因 → 服务端日志（脱敏侧）；对外出参 → 固定文案
    if (!rawDb.ok) this.logger.error(`就绪探针失败 db：${rawDb.error}`);

    // 成功 / 失败两条路径共用同一份结构（失败时把它塞进 BizException 的 payload）
    const body = {
      status: failed.length ? 'not_ready' : 'ready',
      checks: {
        db: {
          ok: rawDb.ok,
          latencyMs: rawDb.latencyMs,
          ...(rawDb.ok ? {} : { detail: '数据库探测失败（原因见服务端日志）' }),
        },
        queue: {
          ok: missing.length === 0,
          latencyMs: 0,
          driver: stats?.driver ?? '-',
          durable: stats?.durable ?? false,
          consumers: QUEUE_NAMES.length - missing.length,
          consumersTotal: QUEUE_NAMES.length,
          ...(missing.length
            ? {
                detail:
                  `${missing.length} 个队列无消费者（任务将无人消费）：` +
                  missing.map((q) => QUEUE_LABEL[q]).join('、'),
              }
            : {}),
        },
      },
      uptimeSec: Math.floor((Date.now() - this.bootedAt) / 1000),
      version,
    };

    if (failed.length) {
      // ⚠️ 必须**显式**传 503：`HTTP_STATUS_OVERRIDE` 里没有 90002，不传就退化成
      //    HTTP 200 —— 而编排器的健康检查只读状态码，会把「不可用」判成健康。
      throw new BizException(
        ErrorCode.SERVICE_UNAVAILABLE,
        `依赖未就绪：${failed.join('、')}`,
        HttpStatus.SERVICE_UNAVAILABLE,
        body,
      );
    }
    return body;
  }
}
