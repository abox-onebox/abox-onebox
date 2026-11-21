import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';

import type { JwtPayload } from '../../src/common/decorators/auth.decorator';
import type { ExportTask } from '../../src/database/entities/export-task.entity';
import { ExportTaskService } from '../../src/modules/export/export-task.service';

/**
 * 导出任务 · 编排判据（2026-11-21）
 *
 * 用一个假仓储/假队列/假存储顶掉下游 —— 本文件**不验证订单取数**（那是 order-admin 的职责），
 * 只钉死导出作业自己最要命的四条：
 *   ① **状态机**：非 pending 不重复跑（队列重复投递幂等）；失败不抛错（不进重试队列）；
 *   ② **权限**：operator 只能看自己提交的，别人的是 Forbidden；非 done 态不给下载；
 *   ③ **产物**：CSV 带 BOM、含引号/逗号正确转义、行数与 fileKey 写回；
 *   ④ **不留僵尸**：入队失败的任务当场标 failed，不会永远卡 pending。
 *
 * 之所以必须有：这四条在 e2e 里都走不到（没有队列消费者被真实触发），
 * 单测缺失就等于人工测试时第一次点导出才发现。
 */

type Task = ExportTask & {
  id: number;
  createdBy: number | null;
  createdName: string | null;
  filterJson: string | null;
  status: string;
};

function mkTask(id: number, over: Partial<Task> = {}): Task {
  return {
    id,
    taskNo: `EXP${id}`,
    kind: 'orders',
    label: '订单明细',
    filterJson: '{}',
    status: 'pending',
    rowCount: 0,
    fileKey: null,
    fileName: null,
    error: null,
    createdBy: 1,
    createdName: 'admin',
    createdAt: new Date(),
    finishedAt: null,
    ...over,
  } as Task;
}

function harness(opts: { enqueueFail?: boolean; exportFail?: boolean } = {}) {
  const rows = new Map<number, ExportTask>();
  let seq = 0;
  let uploaded: { key: string; buffer: Buffer } | null = null;
  const enqueued: string[] = [];
  let handler: ((p: { taskId: number }) => Promise<void>) | null = null;

  const repo = {
    create: (partial: Partial<Task>) => mkTask(++seq, partial),
    save: async (t: Task) => {
      rows.set(t.id, t);
      return t;
    },
    findOne: async ({ where }: { where: { id: number } }) => rows.get(where.id) ?? null,
    createQueryBuilder: (_alias: string) => {
      const state: { me?: number } = {};
      const qb = {
        where: (_sql: string, p?: { me?: number }) => {
          state.me = p?.me;
          return qb;
        },
        orderBy: () => qb,
        take: () => qb,
        getMany: async () =>
          [...rows.values()]
            .filter((t) => state.me === undefined || t.createdBy === state.me)
            .sort((a, b) => b.id - a.id),
      };
      return qb;
    },
  };

  const queue = {
    register: (name: string, fn: (p: { taskId: number }) => Promise<void>) => {
      if (name === 'export-task') handler = fn;
    },
    enqueue: async (name: string, payload: { taskId: number }) => {
      if (opts.enqueueFail) throw new Error('redis down');
      enqueued.push(`${name}:${payload.taskId}`);
    },
  };

  const storage = {
    url: (key: string) => `https://cdn.test/${key}`,
    upload: async (o: { key: string; buffer: Buffer }) => {
      uploaded = o;
    },
  };

  const orderAdmin = {
    exportOrders: async () => {
      if (opts.exportFail) throw new Error('db timeout');
      return {
        headers: ['订单号', '备注'],
        list: [['AB1', '张三, "加急"']],
        fileName: 'ABox_订单.csv',
      };
    },
  };
  const opLog = { listAll: async () => [] };

  const svc = new ExportTaskService(
    repo as never,
    queue as never,
    storage as never,
    orderAdmin as never,
    opLog as never,
  );
  return { svc, rows, enqueued, getUploaded: () => uploaded, getHandler: () => handler };
}

const admin: JwtPayload = { sub: 1, typ: 'admin', role: 'admin', username: 'admin' };
const operator: JwtPayload = { sub: 2, typ: 'admin', role: 'operator', username: 'op' };

describe('ExportTaskService · request', () => {
  it('未知类型当场拒绝，不落库不入队', async () => {
    const h = harness();
    await expect(h.svc.request('hack', {}, admin)).rejects.toThrow(BadRequestException);
    expect(h.rows.size).toBe(0);
    expect(h.enqueued).toEqual([]);
  });

  it('正常提交：pending + 筛选原文 + 提交人快照 + 入队只带主键', async () => {
    const h = harness();
    const task = await h.svc.request('orders', { status: 'delivered' }, admin);
    expect(task.status).toBe('pending');
    expect(task.label).toBe('订单明细');
    expect(task.filterJson).toBe('{"status":"delivered"}');
    expect(task.createdBy).toBe(1);
    expect(task.createdName).toBe('admin');
    expect(h.enqueued).toEqual([`export-task:${task.id}`]);
  });

  it('入队失败：任务当场标 failed，不留永远 pending 的僵尸', async () => {
    const h = harness({ enqueueFail: true });
    await expect(h.svc.request('orders', {}, admin)).rejects.toThrow('redis down');
    const task = [...h.rows.values()][0];
    expect(task.status).toBe('failed');
    expect(task.error).toContain('入队失败');
    expect(task.finishedAt).toBeInstanceOf(Date);
  });
});

describe('ExportTaskService · 权限与下载', () => {
  it('operator 列表只看自己的；admin 看全部', async () => {
    const h = harness();
    await h.svc.request('orders', {}, admin); // createdBy=1
    await h.svc.request('orders', {}, operator); // createdBy=2
    expect(await h.svc.list(operator)).toHaveLength(1);
    expect((await h.svc.list(operator))[0].createdBy).toBe(2);
    expect(await h.svc.list(admin)).toHaveLength(2);
  });

  it('operator 看别人的详情 → Forbidden（越权被拒无副作用）', async () => {
    const h = harness();
    const t = await h.svc.request('orders', {}, admin);
    await expect(h.svc.detail(t.id, operator)).rejects.toThrow(ForbiddenException);
  });

  it('不存在的任务 → NotFound', async () => {
    const h = harness();
    await expect(h.svc.detail(999, admin)).rejects.toThrow(NotFoundException);
  });

  it('非 done 态不给下载；done 态返回存储 URL', async () => {
    const h = harness();
    const t = await h.svc.request('orders', {}, admin);
    await expect(h.svc.downloadUrl(t.id, admin)).rejects.toThrow(BadRequestException);
    t.status = 'done';
    t.fileKey = 'exports/2026-11-21/1-ABox_订单.csv';
    t.fileName = 'ABox_订单.csv';
    await h.rows.set(t.id, t);
    expect(await h.svc.downloadUrl(t.id, admin)).toEqual({
      url: 'https://cdn.test/exports/2026-11-21/1-ABox_订单.csv',
      fileName: 'ABox_订单.csv',
    });
  });
});

describe('ExportTaskService · 状态机与产物', () => {
  it('重复投递：非 pending 一律跳过，不重复生成', async () => {
    const h = harness();
    const t = await h.svc.request('orders', {}, admin);
    t.status = 'done';
    await h.rows.set(t.id, t);
    await h.svc.run(t.id);
    expect(h.getUploaded()).toBeNull();
    expect(t.status).toBe('done');
  });

  it('成功：CSV 带 BOM、逗号与引号正确转义，行数与 fileKey 写回', async () => {
    const h = harness();
    const t = await h.svc.request('orders', {}, admin);
    await h.svc.run(t.id);
    expect(t.status).toBe('done');
    expect(t.rowCount).toBe(1);
    expect(t.fileKey).toContain(`/${t.id}-`);
    const csv = h.getUploaded()!.buffer.toString('utf8');
    expect(csv.charCodeAt(0)).toBe(0xfeff); // Excel 中文列名不乱码
    expect(csv).toContain('"张三, ""加急"""');
  });

  it('生成失败：写回 failed + 原因，不抛错（不进自动重试队列）', async () => {
    const h = harness({ exportFail: true });
    const t = await h.svc.request('orders', {}, admin);
    await expect(h.svc.run(t.id)).resolves.toBeUndefined();
    expect(t.status).toBe('failed');
    expect(t.error).toContain('db timeout');
    expect(t.finishedAt).toBeInstanceOf(Date);
  });

  it('重试：仅 failed 可重试，重置为 pending 并复用原筛选条件重新入队', async () => {
    const h = harness();
    const t = await h.svc.request('orders', {}, admin);
    await expect(h.svc.retry(t.id, admin)).rejects.toThrow(BadRequestException);
    t.status = 'failed';
    t.error = 'db timeout';
    t.finishedAt = new Date();
    await h.rows.set(t.id, t);
    const retried = await h.svc.retry(t.id, admin);
    expect(retried.status).toBe('pending');
    expect(retried.error).toBeNull();
    expect(retried.finishedAt).toBeNull();
    expect(retried.filterJson).toBe('{}'); // 原文复用，没被重写
    expect(h.enqueued).toEqual([`export-task:${t.id}`, `export-task:${t.id}`]);
  });

  it('onModuleInit 注册的消费者能真实驱动一次导出', async () => {
    const h = harness();
    h.svc.onModuleInit();
    const fn = h.getHandler();
    expect(fn).not.toBeNull();
    const t = await h.svc.request('orders', {}, admin);
    await fn!({ taskId: t.id });
    expect(t.status).toBe('done');
  });
});
