import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { QueueService } from '../../common/queue/queue.service';
import type { ExportTaskPayload } from '../../queues/queue-payloads';
import { STORAGE_PROVIDER, StorageProvider } from '../../providers/storage/storage.provider';
import type { JwtPayload } from '../../common/decorators/auth.decorator';
import { ExportTask } from '../../database/entities/export-task.entity';
import { OperationLogService } from '../admin/operation-log/operation-log.service';
import { OrderAdminService } from '../order/order-admin.service';

export type ExportKind = 'orders' | 'operation-logs';

const LABELS: Record<ExportKind, string> = {
  orders: '订单明细',
  'operation-logs': '操作日志',
};

/** 任务化导出的硬上限：比同步入口的 5000 大一个量级，且不阻塞 HTTP 请求 */
const EXPORT_TASK_MAX_ROWS = 100000;

type OrderFilter = Parameters<OrderAdminService['exportOrders']>[0];
type OpLogFilter = Parameters<OperationLogService['listAll']>[0];

function csvCell(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  // BOM 头：不加的话 Excel 打开中文列名会乱码（与端上原同步导出一致）
  return `\uFEFF${[headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}`;
}

/**
 * 后台导出作业（2026-11-21）
 *
 * ## 为什么是「落库 + 队列」而不是同步吐文件
 * 同步导出在订单侧被 5000 行截断、在操作日志侧被分页钳到 100 条；
 * 两者都在前端拼 CSV，界面卡死且无任务记录。这里把导出拆成：
 *   request（即时返回 taskId）→ 队列 → run（生成文件 + 写回产物）→ 下载中心取件。
 *
 * ## 为什么消费者注册在本服务而不是 `queues/`
 * 本服务的依赖面（订单 / 操作日志 / 存储）只在这里出现；放到 `QueuesModule`
 * 会让队列模块反向依赖两个业务模块，还多一次模块装配。队列实例由全局
 * `CommonModule` 提供，任何模块都能 `register`，无需经 `QueuesModule` 转手。
 *
 * ## 失败语义（队列契约）
 * handler **不抛错**：失败写回 `failed` + 原因，由运营在下载中心点「重试」。
 * 自动重试对「导出」没有意义 —— 同样的筛选条件重试三次还是同样失败，
 * 只会把死信队列塞满、让真正的队列故障淹没在噪音里。
 */
@Injectable()
export class ExportTaskService implements OnModuleInit {
  private readonly logger = new Logger('ExportTask');

  constructor(
    @InjectRepository(ExportTask) private readonly repo: Repository<ExportTask>,
    private readonly queue: QueueService,
    @Inject(STORAGE_PROVIDER) private readonly storage: StorageProvider,
    private readonly orderAdmin: OrderAdminService,
    private readonly opLog: OperationLogService,
  ) {}

  onModuleInit(): void {
    this.queue.register('export-task', (payload) =>
      this.run((payload as ExportTaskPayload).taskId),
    );
  }

  /** 提交导出：任务行先落库，再入队（入队失败如实标记 failed，不留永远 pending 的僵尸任务） */
  async request(
    kind: string,
    filter: Record<string, unknown>,
    actor: JwtPayload,
  ): Promise<ExportTask> {
    if (!Object.prototype.hasOwnProperty.call(LABELS, kind)) {
      throw new BadRequestException(`不支持的导出类型：${kind}`);
    }
    const task = this.repo.create({
      taskNo: this.taskNo(),
      kind,
      label: LABELS[kind as ExportKind],
      filterJson: JSON.stringify(filter ?? {}),
      status: 'pending',
      rowCount: 0,
      createdBy: actor?.sub ?? null,
      createdName: actor?.username ?? null,
    });
    const saved = await this.repo.save(task);

    try {
      await this.queue.enqueue('export-task', {
        taskId: saved.id,
      } satisfies ExportTaskPayload);
    } catch (e) {
      saved.status = 'failed';
      saved.error = `入队失败：${(e as Error).message}`.slice(0, 500);
      saved.finishedAt = new Date();
      await this.repo.save(saved);
      throw e;
    }
    return saved;
  }

  /** 下载中心列表（operator 只看自己提交的，其余角色看全部） */
  async list(actor: JwtPayload): Promise<ExportTask[]> {
    const qb = this.repo.createQueryBuilder('t');
    if (actor?.role === 'operator') qb.where('t.created_by = :me', { me: actor.sub });
    qb.orderBy('t.id', 'DESC').take(100);
    return qb.getMany();
  }

  /** 详情（权限同 list：operator 只能看自己的） */
  async detail(id: number, actor: JwtPayload): Promise<ExportTask> {
    const task = await this.repo.findOne({ where: { id } });
    if (!task) throw new NotFoundException('导出任务不存在');
    this.assertVisible(task, actor);
    return task;
  }

  /** 产物下载地址 —— 文件在 StorageProvider 里，端点只返回 URL（不做二次文件流） */
  async downloadUrl(id: number, actor: JwtPayload): Promise<{ url: string; fileName: string }> {
    const task = await this.detail(id, actor);
    if (task.status !== 'done' || !task.fileKey) {
      throw new BadRequestException('任务尚未完成，没有可下载的文件');
    }
    return {
      url: this.storage.url(task.fileKey),
      fileName: task.fileName ?? `导出任务-${task.id}.csv`,
    };
  }

  /** 失败重试：重置为 pending 后重新入队（同一 taskId，筛选条件原样复用） */
  async retry(id: number, actor: JwtPayload): Promise<ExportTask> {
    const task = await this.detail(id, actor);
    if (task.status !== 'failed') throw new BadRequestException('仅失败任务可重试');
    task.status = 'pending';
    task.error = null;
    task.finishedAt = null;
    await this.repo.save(task);
    await this.queue.enqueue('export-task', {
      taskId: task.id,
    } satisfies ExportTaskPayload);
    return task;
  }

  /** 队列消费者：生成文件并写回任务行（重复投递时以 status 幂等） */
  async run(taskId: number): Promise<void> {
    const task = await this.repo.findOne({ where: { id: taskId } });
    if (!task || task.status !== 'pending') return;

    task.status = 'running';
    await this.repo.save(task);
    try {
      const filter = JSON.parse(task.filterJson || '{}') as Record<string, unknown>;
      const { headers, rows, fileName } = await this.generate(
        task.kind as ExportKind,
        filter,
        Number(task.createdBy ?? 0),
      );
      const key = `exports/${new Date().toISOString().slice(0, 10)}/${task.id}-${fileName}`;
      await this.storage.upload({
        key,
        buffer: Buffer.from(toCsv(headers, rows), 'utf8'),
        contentType: 'text/csv; charset=utf-8',
      });
      task.status = 'done';
      task.rowCount = rows.length;
      task.fileKey = key;
      task.fileName = fileName;
    } catch (e) {
      task.status = 'failed';
      task.error = (e as Error).message.slice(0, 500);
      this.logger.warn(`导出任务 #${taskId} 失败：${task.error}`);
    } finally {
      task.finishedAt = new Date();
      await this.repo.save(task);
    }
  }

  private assertVisible(task: ExportTask, actor: JwtPayload): void {
    if (actor?.role === 'operator' && task.createdBy !== actor.sub) {
      throw new ForbiddenException('仅能查看自己提交的导出任务');
    }
  }

  private taskNo(): string {
    return `EXP${Date.now()}${Math.floor(Math.random() * 1000)
      .toString()
      .padStart(3, '0')}`;
  }

  /** 各导出类型只在这里注册一个生成器 —— 筛选口径仍来自各域既有 service */
  private async generate(
    kind: ExportKind,
    filter: Record<string, unknown>,
    operatorId: number,
  ): Promise<{ headers: string[]; rows: unknown[][]; fileName: string }> {
    if (kind === 'orders') {
      const r = await this.orderAdmin.exportOrders(
        filter as OrderFilter,
        operatorId,
        undefined,
        EXPORT_TASK_MAX_ROWS,
      );
      return { headers: r.headers, rows: r.list, fileName: r.fileName };
    }

    const items = await this.opLog.listAll(filter as OpLogFilter);
    return {
      headers: [
        'ID',
        '时间',
        '操作人',
        '角色',
        '模块',
        '操作',
        '对象ID',
        '结果',
        'IP',
        'KB操作人',
        '自然语言意图',
        '操作块',
      ],
      rows: items.map((r) => [
        r.id,
        r.createdAt ?? '',
        r.operatorName ?? '',
        r.operatorRoleLabel ?? '',
        r.module ?? '',
        r.action ?? '',
        r.targetId ?? '',
        r.failed ? '失败' : '成功',
        r.requestIp ?? '',
        r.kbOperator ?? '',
        r.kbNlIntent ?? '',
        r.kbOpBlock !== null && r.kbOpBlock !== undefined ? JSON.stringify(r.kbOpBlock) : '',
      ]),
      fileName: `ABox_操作日志_${new Date().toISOString().slice(0, 10)}.csv`,
    };
  }
}
