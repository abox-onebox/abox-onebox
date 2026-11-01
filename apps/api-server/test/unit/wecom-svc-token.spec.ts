import { WecomSvcTokenService } from '../../src/modules/wecom-kb/wecom-svc-token.service';

/**
 * 服务账号令牌自续（企业微信 KB 助手）
 *
 * 为什么这几条要钉死：
 *   `adminLogin` 连错 5 次会**锁账号 15 分钟**。若这里在配置错的情况下还疯狂重试，
 *   运维会陷入「怎么改口令都不生效」的假象。故「失败后冷却、期间不再发请求」是安全判据，
 *   不是性能优化 —— 必须有测试拦。
 *
 * 另一条：令牌提前续期的余量算错（ttl 很小的时候算出负数）会导致每次调用都重新登录，
 *   同样会把账号打进锁定。故对 expiresIn 极小值也断言一次。
 */

type FetchMock = jest.Mock;

const okBody = (token = 'tok-1', expiresIn = 604800) => ({
  text: async () => JSON.stringify({ code: 0, message: 'ok', data: { token, expiresIn } }),
});

const failBody = (code = 20005) => ({
  text: async () => JSON.stringify({ code, message: '账号或密码错误', data: null }),
});

describe('WecomSvcTokenService', () => {
  const OLD_ENV = process.env;
  let fetchMock: FetchMock;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.WECOM_SVC_USERNAME;
    delete process.env.WECOM_SVC_PASSWORD;
    fetchMock = jest.fn();
    (global as unknown as { fetch: FetchMock }).fetch = fetchMock;
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  it('未配置账号口令：返回 null 且不发任何请求', async () => {
    const svc = new WecomSvcTokenService();
    expect(svc.isConfigured()).toBe(false);
    await expect(svc.get()).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('登录成功：返回令牌，且第二次走缓存不再请求', async () => {
    process.env.WECOM_SVC_USERNAME = 'kb-bot';
    process.env.WECOM_SVC_PASSWORD = 'secret';
    fetchMock.mockResolvedValue(okBody('tok-1'));

    const svc = new WecomSvcTokenService();
    await expect(svc.get()).resolves.toBe('tok-1');
    await expect(svc.get()).resolves.toBe('tok-1');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('并发取令牌：只登录一次（单飞，避免瞬间打出多次失败把账号锁死）', async () => {
    process.env.WECOM_SVC_USERNAME = 'kb-bot';
    process.env.WECOM_SVC_PASSWORD = 'secret';
    fetchMock.mockResolvedValue(okBody('tok-2'));

    const svc = new WecomSvcTokenService();
    const [a, b, c] = await Promise.all([svc.get(), svc.get(), svc.get()]);
    expect([a, b, c]).toEqual(['tok-2', 'tok-2', 'tok-2']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('登录失败：返回 null，冷却期内不再发请求', async () => {
    process.env.WECOM_SVC_USERNAME = 'kb-bot';
    process.env.WECOM_SVC_PASSWORD = 'wrong';
    fetchMock.mockResolvedValue(failBody(20005));

    const svc = new WecomSvcTokenService();
    await expect(svc.get()).resolves.toBeNull();
    await expect(svc.get()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络异常：返回 null 而不是抛出（不能把整条消息处理链打断）', async () => {
    process.env.WECOM_SVC_USERNAME = 'kb-bot';
    process.env.WECOM_SVC_PASSWORD = 'secret';
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));

    const svc = new WecomSvcTokenService();
    await expect(svc.get()).resolves.toBeNull();
  });

  it('invalidate 后下一轮重新登录（令牌被后台判失效 10002 的场景）', async () => {
    process.env.WECOM_SVC_USERNAME = 'kb-bot';
    process.env.WECOM_SVC_PASSWORD = 'secret';
    fetchMock.mockResolvedValueOnce(okBody('tok-a')).mockResolvedValueOnce(okBody('tok-b'));

    const svc = new WecomSvcTokenService();
    await expect(svc.get()).resolves.toBe('tok-a');
    svc.invalidate();
    await expect(svc.get()).resolves.toBe('tok-b');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expiresIn 极小（1 秒）时缓存期不超过真实 TTL，不会拿失效令牌去调接口', async () => {
    process.env.WECOM_SVC_USERNAME = 'kb-bot';
    process.env.WECOM_SVC_PASSWORD = 'secret';
    fetchMock.mockResolvedValue(okBody('tok-1s', 1));

    const svc = new WecomSvcTokenService();
    await expect(svc.get()).resolves.toBe('tok-1s');
    // TTL 1 秒：等 1.1 秒后缓存必须已过期，重新登录（不能拿死令牌继续用）
    await new Promise((r) => setTimeout(r, 1100));
    await expect(svc.get()).resolves.toBe('tok-1s');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('expiresIn 缺失时按 7 天兜底（不视为 0 秒立即过期）', async () => {
    process.env.WECOM_SVC_USERNAME = 'kb-bot';
    process.env.WECOM_SVC_PASSWORD = 'secret';
    fetchMock.mockResolvedValue({
      text: async () => JSON.stringify({ code: 0, data: { token: 'tok-x' } }),
    });

    const svc = new WecomSvcTokenService();
    await expect(svc.get()).resolves.toBe('tok-x');
    await expect(svc.get()).resolves.toBe('tok-x');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
