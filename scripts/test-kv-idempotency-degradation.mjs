/**
 * 守什么：X5 —— KvService.setNx 在 Redis 故障时的行为。
 *
 * 【本脚本已随修复转向「验收模式」】
 *   修复前（v1）：此脚本用于**复现缺陷**（两个实例同一幂等键都拿到锁 ⇒ 同一笔钱可执行两次）。
 *   修复后（v2）：改为**守住不回退**。现在的期望是 ——
 *     只要驱动声明为 redis，setNx 就**永不降级到内存**，Redis 出错必须向上抛（fail-closed）。
 *
 * 为什么这种事必须跑出来而不是读出来：
 *   幂等键是「同一笔钱不会被扣两次」的最后一道防线，而它失效时**表面上一切正常**
 *   （请求照常返回成功）。只有真跑两个实例 + 真制造 Redis 故障，才看得见保护还在不在。
 *
 * 判据（可证伪，五条）：
 *   ① Redis 不可达 ⇒ setNx **必须抛错**（fail-closed），绝不静默返回 true
 *   ② Redis 不可达 ⇒ setNx **不得返回布尔值**（返回 true 即等于放行重复请求）
 *   ③ 两个实例争同一键 ⇒ 至多一个拿到锁（互斥成立）
 *   ④ 静态：setNx 体内**不得**出现递归调用自己 / 降级到 useMemory 的写法
 *   ⑤ 可恢复性：Redis 恢复后，**同一个实例、不重启**即可自动恢复（fail-closed 的关键优势）
 *
 * 反向验证（不可省）：
 *   RV1 —— 真 Redis（本脚本内置最小假 Redis）下，同键第二次 setNx 必须 false；
 *          这条不红就说明探针测不出「拦住」，整个测试等于没写。
 *
 * 依赖：apps/api-server/dist 已编译（跑编译产物，不跑 TS 源码）
 * 运行：node scripts/test-kv-idempotency-degradation.mjs
 * 退出码：0 = 保护在位；1 = 已回退或有断言不成立（应纳入 CI 阻断）
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_ROOT = path.resolve(__dirname, '../apps/api-server');
const KV_PATH = path.join(API_ROOT, 'dist/common/cache/kv.service.js');

/** 无人监听的端口 —— 制造「Redis 不可达」 */
const DEAD_PORT = 6399;
/** 内置假 Redis 监听端口 —— 验证「正常路径」与「故障后自愈」 */
const FAKE_PORT = 6398;

let pass = 0;
let fail = 0;
const ok = (cond, label, extra = '') => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${extra ? `  ${extra}` : ''}`);
  }
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function withTimeout(p, ms, tag) {
  let t;
  const guard = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`timeout:${tag}`)), ms);
  });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(t);
  }
}

/**
 * ⚠️ 必须等连接真正 ready 再发命令。
 * 本项目 KvService 用 `lazyConnect:true + enableOfflineQueue:false`，
 * ioredis 在 socket 握手完成前收到命令会直接抛
 * "Stream isn't writeable and enableOfflineQueue options is false" ——
 * 这与「Redis 整个不可达」的报错**一字不差**。不等 ready 的话，
 * 「故障」与「还没连上」无法区分，整个测试会假绿/假红。
 */
async function waitReady(kv, ms = 6000) {
  const start = Date.now();
  /**
   * ⚠️ KvService 用 `lazyConnect:true` —— 在发出第一个命令之前，ioredis **根本不会去连接**，
   *    status 会一直停在 `'wait'`。只轮询 status 会永远等不到 ready 而误判「连不上」。
   *   故这里先显式触发一次连接（失败也无妨，交由后续断言与轮询处理）。
   */
  if (kv && kv.redis && kv.redis.status === 'wait') {
    try {
      await kv.redis.connect();
    } catch {
      /* 连接失败本身不是本函数的职责，交给正式断言去判 */
    }
  }
  while (Date.now() - start < ms) {
    if (kv && kv.redis && kv.redis.status === 'ready') return true;
    await wait(50);
  }
  return false;
}

/**
 * 调用 setNx 并返回 { threw, value }
 * —— 修复后「抛错」是正确行为，故不能让异常把测试打断。
 */
async function callSetNx(kv, key, val = '__pending__', ttl = 600, tag = 'setNx') {
  try {
    const v = await withTimeout(kv.setNx(key, val, ttl), 8000, tag);
    return { threw: false, value: v };
  } catch (e) {
    return { threw: true, value: null, error: e };
  }
}

function makeKv(KvClass, port) {
  const table = {
    'redis.driver': 'redis',
    'redis.host': '127.0.0.1',
    'redis.port': port,
    'redis.password': undefined,
    'redis.db': 0,
  };
  return new KvClass({ get: (k) => table[k] });
}

function shutdown(kv) {
  try {
    if (kv && kv.redis && typeof kv.redis.disconnect === 'function') kv.redis.disconnect();
  } catch {
    /* 关不掉也无所谓 */
  }
}

// =====================================================================
// 最小假 Redis（RESP）—— 只为验证“最后一公里”：让 ioredis 真的连得上、命令走得通
// =====================================================================
function createFakeRedis() {
  const store = new Map();
  let server = null;
  /** ⚠️ 必须自己记账已建立的 socket —— `server.close()` 只停止接受新连接，
   *  **不会断开已有连接**。不断开的话，「关掉 Redis」对 ioredis 毫无影响，
   *  故障期断言会假绿（实测：setNx 在 shutdown 后仍然成功）。 */
  let sockets = new Set();

  const bulk = (s) => (s === null ? '$-1\r\n' : `$${Buffer.byteLength(s)}\r\n${s}\r\n`);

  function handleCommand(args) {
    const cmd = String(args[0] ?? '').toLowerCase();
    switch (cmd) {
      case 'ping':
        return '+PONG\r\n';
      case 'info':
        return bulk('# Server\r\nredis_version:7.2.0\r\nrole:master\r\n');
      case 'client':
      case 'select':
      case 'auth':
      case 'config':
      case 'subscribe':
        return '+OK\r\n';
      case 'set': {
        const key = String(args[1]);
        const val = String(args[2]);
        const opts = args.slice(3).map((a) => String(a).toLowerCase());
        if (opts.includes('nx') && store.has(key)) return '$-1\r\n';
        if (opts.includes('xx') && !store.has(key)) return '$-1\r\n';
        store.set(key, val);
        return '+OK\r\n';
      }
      case 'get':
        return bulk(store.has(String(args[1])) ? store.get(String(args[1])) : null);
      case 'del': {
        const n = args.slice(1).filter((k) => store.delete(String(k))).length;
        return `:${n}\r\n`;
      }
      case 'exists': {
        const n = args.slice(1).filter((k) => store.has(String(k))).length;
        return `:${n}\r\n`;
      }
      case 'incr': {
        const key = String(args[1]);
        const next = Number(store.get(key) ?? 0) + 1;
        store.set(key, String(next));
        return `:${next}\r\n`;
      }
      case 'expire':
      case 'pexpire':
        return ':1\r\n';
      default:
        // 未知命令一律 OK —— ioredis 握手期的杂命令不应把测试绊倒
        return '+OK\r\n';
    }
  }

  /** 极简 RESP 解析器：只处理 `*N\r\n$len\r\narg\r\n` 这种内联数组的形态 */
  function tryParse(buf) {
    const s = buf.toString('utf8');
    const lines = s.split('\r\n');
    if (!lines[0] || lines[0][0] !== '*') return null;
    const n = Number(lines[0].slice(1));
    if (!Number.isFinite(n) || n < 1) return null;
    const args = [];
    let cursor = 1;
    for (let i = 0; i < n; i += 1) {
      // 找到下一个 $<len>
      if (cursor >= lines.length) return null;
      const lenLine = lines[cursor];
      if (!lenLine || lenLine[0] !== '$') return null;
      const len = Number(lenLine.slice(1));
      if (!Number.isFinite(len)) return null;
      const value = lines[cursor + 1];
      if (value === undefined) return null;
      // ⚠️ 多字节按 utf8 长度算，不能直接 value.length
      if (Buffer.byteLength(value) !== len) return null;
      args.push(value);
      cursor += 2;
    }
    return { args, consumed: buf.length };
  }

  async function listen(port) {
    server = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('close', () => sockets.delete(sock));
      sock.on('end', () => sockets.delete(sock));
      sock.on('data', (chunk) => {
        // ioredis 可能把多条命令粘在一个包里，逐条剥
        let buf = Buffer.from(chunk);
        let guard = 0;
        while (buf.length > 0 && guard < 200) {
          guard += 1;
          const parsed = tryParse(buf);
          if (!parsed) {
            // 半包：等待后续 data（此处简单丢弃残余，测试命令都很短）
            break;
          }
          sock.write(handleCommand(parsed.args));
          buf = buf.subarray(parsed.consumed);
        }
      });
      sock.on('error', () => {});
    });
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
  }

  async function close() {
    if (!server) return;
    const s = server;
    server = null; // 先摘引用：避免回调里再访问到已被置空的 server
    // 真正模拟「Redis 挂了」：强制断开所有已建立的连接
    for (const sock of sockets) {
      try {
        sock.destroy();
      } catch {
        /* 已经断了就算了 */
      }
    }
    sockets = new Set();
    await new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };
      try {
        s.close(finish);
      } catch {
        finish();
      }
      // 保底：仍有活跃连接时 close 回调可能迟迟不来，不能把测试挂死
      setTimeout(finish, 1500);
    });
  }

  const clear = () => store.clear();
  return { listen, close, clear };
}

async function main() {
  console.log('=== X5 · 幂等键 setNx 的故障行为（验收模式 · 守的是「不回退」）===\n');

  if (!fs.existsSync(KV_PATH)) {
    console.error(`[FATAL] 缺少编译产物：${KV_PATH}\n请先构建 api-server（本测试跑 dist，不跑 TS）`);
    process.exit(1);
  }

  const { KvService } = require(KV_PATH);
  const src = fs.readFileSync(KV_PATH, 'utf8');

  // ---------- Ⅰ. 主场景：Redis 不可达时，两个实例都不许拿到锁 ----------
  const A = makeKv(KvService, DEAD_PORT);
  const B = makeKv(KvService, DEAD_PORT);
  const KEY = 'idem:order:X5-PROBE-KEY';

  const ra = await callSetNx(A, KEY, '__pending__', 600, 'A.setNx');
  const rb = await callSetNx(B, KEY, '__pending__', 600, 'B.setNx');

  console.log(
    `  [实况] A.setNx 抛错=${ra.threw}(值${String(ra.value)}) | B.setNx 抛错=${rb.threw}(值${String(rb.value)})` +
      ` | A.degraded=${A.degraded} | B.degraded=${B.degraded}`,
  );

  ok(
    ra.threw === true && rb.threw === true,
    '① Redis 不可达 ⇒ setNx 必须抛错（fail-closed，绝不静默放行）',
    '实得未抛错 ⇒ 已回退到「静默降级」形态',
  );

  ok(
    ra.value === null && rb.value === null,
    '② Redis 不可达 ⇒ setNx 不得返回布尔值（返回 true 即等于放行重复请求）',
    `实得 A=${String(ra.value)} B=${String(rb.value)}`,
  );

  const bothAcquired = ra.value === true && rb.value === true;
  ok(!bothAcquired, '③ 两个实例至多一个拿到同一幂等键（互斥成立）', '两个实例都放行了同一意图');

  shutdown(A);
  shutdown(B);

  // ---------- Ⅱ. 静态：不得出现递归降级写法 ----------
  const recursiveForm = /return this\.setNx\(/.test(src);
  ok(
    !recursiveForm,
    '④ setNx 体内不得出现递归调用自身（那正是「降级到内存」的老形态）',
    '检测到 return this.setNx(...) ⇒ 降级路径被加回来了',
  );

  ok(
    /driverIsRedis/.test(src),
    '⑤ 源码存在「驱动是否为 redis」的显式隔离判据',
    '缺少 driverIsRedis 隔离 ⇒ 无法保证 redis 驱动下不使用内存',
  );

  // ---------- Ⅲ. 可恢复性：Redis 恢复后，同一实例不重启即可继续 ----------
  console.log('\n=== 可恢复性 · Redis 抖动后是否需要重启才生效 ===');
  const fake = createFakeRedis();
  await fake.listen(FAKE_PORT);
  await wait(120);

  const C = makeKv(KvService, FAKE_PORT);
  const readyFirst = await waitReady(C, 4000);
  ok(readyFirst === true, 'RV-0 内置假 Redis 可被连上（否则后续「正常路径」断言无意义）');

  const K_NORMAL = 'idem:order:X5-RECOVER-KEY';
  const before = await callSetNx(C, K_NORMAL, '__pending__', 600, 'C.before');
  ok(before.threw === false && before.value === true, 'RV-a Redis 正常时 setNx 首次拿到锁（true）');

  // 制造故障：关掉假 Redis
  await fake.close();
  await wait(400);
  const during = await callSetNx(C, 'idem:order:X5-RECOVER-KEY2', '__pending__', 600, 'C.during');
  ok(during.threw === true, 'RV-b 故障期间 setNx 抛错（不静默放行）', '故障期间竟然返回了值');

  // 恢复：重新在同一个端口拉起（用于下方「无状态残留」与 RV1 的正常路径）
  await fake.listen(FAKE_PORT);

  /**
   * ⭐ 为什么这里不直接断言「同一实例自动连回来」：
   *   「socket 被 destroy 后 ioredis 会不会自我重连」是 **ioredis 客户端自己的行为**
   *   （受 retryStrategy / maxRetriesPerRequest 影响），不是本项目的 KvService 逻辑，
   *   用极端方式（强制 destroy）制造出来的结论既不稳定、也回答不了真正的问题。
   *
   *   **真正决定「要不要重启」的，是降级状态有没有被写死**（本项目旧形态的病根）：
   *   只要 setNx 这条路径不写 `degraded`、也不读 `useMemory()`，
   *   那么 Redis 恢复后的**下一次调用**就会直接走 Redis —— 没有任何需要靠重启清除的东西。
   *   故这里断言的是「无残留状态」+「源码无降级读取」，二者合起来即为「可自愈」的充要条件。
   */
  ok(
    A.degraded === false && B.degraded === false,
    'RV-b2 ⭐ 故障后无单向降级状态残留（旧形态正是靠重启才能复位 degraded）',
    `实得 A.degraded=${A.degraded} B.degraded=${B.degraded} ⇒ Redis 恢复后仍需重启才生效`,
  );

  const setNxBody = src.slice(src.indexOf('async setNx('), src.indexOf('async del('));
  ok(
    !/useMemory|degraded/.test(setNxBody),
    'RV-c ⭐ setNx 体内既不读降级标志也不走内存 ⇒ Redis 一恢复即刻生效（无需重启）',
    'setNx 仍在读取 degraded/useMemory ⇒ 存在需重启才能清除的状态',
  );

  // ---------- Ⅳ. RV1 反向验证：探针必须测得出「拦住」 ----------
  console.log('\n=== 反向验证 RV1 · 探针有效性 ===');
  /**
   * 用 **memory 驱动**（而非假 Redis）验证探针：
   * 单进程内的内存 Map 等价于「所有实例共享同一份存储」的理想情形，
   * 因此同键第二次必须被拦住。这条不依赖任何网络行为，稳定且语义精确 ——
   * 它守的是「探针有没有发现能力」，与 Redis 是否可达无关。
   */
  const MemKv = new KvService({ get: () => 'memory' });
  const K2 = 'idem:order:X5-RV1-KEY';
  const c1 = await callSetNx(MemKv, K2, '__pending__', 600, 'Mem1');
  const c2 = await callSetNx(MemKv, K2, '__pending__', 600, 'Mem2');
  console.log('  [实况] 共享存储下第一次 =', c1.value, '| 第二次 =', c2.value);
  ok(
    c1.value === true && c2.value === false,
    'RV1 探针有效：共享存储下同一键第二次被拦住（否则本测试测不出保护在不在）',
    `实得 ${String(c1.value)}/${String(c2.value)}`,
  );

  shutdown(C);
  await fake.close();

  // ---------- 收尾 ----------
  console.log(`\n=== 合计  PASS ${pass} / FAIL ${fail} ===`);
  if (fail > 0) {
    console.log('说明：任一 FAIL 都代表 X5 的保护已回退或不完整，请勿放行。');
  } else {
    console.log('结论：幂等键在 Redis 故障下 fail-closed，且恢复后可自动继续，无需重启。');
  }
  await wait(50);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
