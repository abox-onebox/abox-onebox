import { PageTrack } from '../../src/database/entities/system.entity';
import {
  PAGE_TRACK_RETENTION_DAYS,
  PageTrackCleanupTask,
  retentionCutoff,
} from '../../src/modules/track/page-track-cleanup.task';

/**
 * 页面停留数据保留清理（U15 合规闭环）
 *
 * 自证口径：
 *   ① 180 天与隐私政策逐字一致（改了正文就必须改这里，两边对不上=合规事故）；
 *   ② 截止值用**绝对时刻**断言（与运行机器时区无关）；
 *   ③ 删除语句的 where 与参数必须真的是「created_at < 截止时刻」——
 *      （`created_at < :cutoff` 若写成 `<=` 或参数传错，测试要能抓住）；
 *   ④ 重入闸与失败隔离各有一条**只靠它才生效**的样本。
 */

describe('页面停留数据保留清理', () => {
  const NOW = new Date('2026-10-20T12:00:00.000Z');

  it('保留期 = 180 天（与端上隐私政策第四节逐字一致）', () => {
    expect(PAGE_TRACK_RETENTION_DAYS).toBe(180);
  });

  it('截止时刻 = now - 180 天（纯毫秒算术，绝对时刻断言）', () => {
    // 2026-04-23T12:00:00Z → 2026-10-20T12:00:00Z 恰好 180 天
    expect(retentionCutoff(NOW).toISOString()).toBe('2026-04-23T12:00:00.000Z');
  });

  it('截止时长不受时区/夏令时影响（跨一小时的偏移仍恰好 180 天）', () => {
    const shifted = new Date('2026-10-20T23:59:59.999Z');
    const diff = shifted.getTime() - retentionCutoff(shifted).getTime();
    expect(diff).toBe(PAGE_TRACK_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  });

  describe('cleanup()', () => {
    /** 造一个可捕获 where/参数的假 Repository（不起真库） */
    function makeRepo(opts: { affected?: number; reject?: Error } = {}) {
      const captured: { where?: string; params?: unknown } = {};
      const execute = opts.reject
        ? jest.fn().mockRejectedValue(opts.reject)
        : jest.fn().mockResolvedValue({ affected: opts.affected ?? 7 });
      // ⚠️ 必须显式注解：qb 在自己的 where 实现里被 return，缺注解会 TS7022
      const qb: {
        delete: jest.Mock;
        from: jest.Mock;
        where: jest.Mock;
        execute: jest.Mock;
      } = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn((w: string, p: unknown) => {
          captured.where = w;
          captured.params = p;
          return qb;
        }),
        execute,
      };
      const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      return { repo: repo as never, qb, captured, execute };
    }

    it('按「created_at < 截止时刻」删除，并返回受影响行数', async () => {
      const { repo, captured, qb, execute } = makeRepo({ affected: 7 });
      const task = new PageTrackCleanupTask(repo);

      const removed = await task.cleanup(NOW);

      expect(removed).toBe(7);
      expect(qb.delete).toHaveBeenCalledTimes(1);
      expect(qb.from).toHaveBeenCalledWith(PageTrack);
      expect(captured.where).toBe('created_at < :cutoff');
      expect(captured.params).toEqual({ cutoff: retentionCutoff(NOW) });
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it('截止时刻取注入的 now（不读真实时钟，断言才可复现）', async () => {
      const { repo, captured } = makeRepo();
      const task = new PageTrackCleanupTask(repo);

      await task.cleanup(NOW);

      const cutoff = (captured.params as { cutoff: Date }).cutoff;
      expect(cutoff.getTime()).toBe(NOW.getTime() - 180 * 24 * 60 * 60 * 1000);
    });

    it('重入闸：上一次未结束时本次直接跳过（不并发两条 DELETE）', async () => {
      let release!: (v: { affected: number }) => void;
      const execute = jest.fn(
        () =>
          new Promise<{ affected: number }>((resolve) => {
            release = resolve;
          }),
      );
      const qb = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute,
      };
      const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) } as never;
      const task = new PageTrackCleanupTask(repo);

      const first = task.cleanup(NOW); // 挂起在 execute 上
      const second = await task.cleanup(NOW); // 应被重入闸挡掉

      expect(await second).toBe(0);
      expect(execute).toHaveBeenCalledTimes(1); // 只有第一条真发了 DELETE

      release({ affected: 5 });
      expect(await first).toBe(5);
    });

    it('失败隔离：删除抛错时吞掉并返回 0（不向上抛，服务不受影响）', async () => {
      const { repo } = makeRepo({ reject: new Error('connection lost') });
      const task = new PageTrackCleanupTask(repo);

      await expect(task.cleanup(NOW)).resolves.toBe(0);
    });

    it('affected 缺省（驱动不回报）时按 0 计，不抛', async () => {
      const execute = jest.fn().mockResolvedValue({});
      const qb = {
        delete: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        execute,
      };
      const repo = { createQueryBuilder: jest.fn().mockReturnValue(qb) } as never;
      const task = new PageTrackCleanupTask(repo);

      await expect(task.cleanup(NOW)).resolves.toBe(0);
    });
  });
});
