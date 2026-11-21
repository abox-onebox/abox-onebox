import { Column, CreateDateColumn, Entity, Index } from 'typeorm';

import { bigintTransformer, PkColumn } from './transformers';

/**
 * ab_export_task · 后台异步导出任务（第 38 张表 · 2026-11-21）
 *
 * ## 为什么要落库，而不是「接口直接吐文件」
 *
 * 改造前订单导出是同步的：服务端最多 5000 行、超了让运营「缩小筛选范围分批导出」，
 * 前端把二维数组拼成 CSV。三个问题同时存在：
 *   ① 大批量导出把 HTTP 请求拖长，界面卡住；
 *   ② 没有任何任务记录 —— 「刚才那次到底导了多少、文件在哪」无从查；
 *   ③ 没有失败重试的落点，导出失败只能重新点一遍。
 *
 * 本表把「导出」变成一次**可追踪的作业**：请求即时返回 taskId，生成交给队列，
 * 完成后的文件 key 与行数写回本表，运营去下载中心取。任务行是**事实源**，
 * 队列里的 payload 只有主键（重试时回库读最新状态）。
 *
 * ## 为什么不按「每种导出一张表」
 * 各导出的差异只在 `kind` 与 `filter_json`，生命周期完全一致（pending→running→done/failed）。
 * 分表会让「我最近导了什么」变成多次 UNION，收益只有字段微调。
 *
 * ## 与 `ab_operation_log` 的关系
 * 提交导出仍由 `ExportTaskController` 的 `@OperationLog()` 写一条审计（谁在什么筛选下发起）；
 * 本表记的是**作业状态与产物**，两者正交，不互相替代。
 *
 * ## 类型注意（schema:parity / index:parity 判据）
 * - `content` 类大字段一律 TEXT（TYPE_ALIAS 未登记 MEDIUMTEXT/LONGTEXT）；
 * - `filter_json` 存 JSON **文本**，与 ab_sys_config / ab_ai_insight 同口径；
 * - 无外键（项目约定）；无 version 列（作业状态单次推进，不争抢资源）；
 * - 索引均带 created_at，避免列表页按状态/提交人过滤后回表排序。
 */
@Entity('ab_export_task')
@Index('idx_export_task_status_created', ['status', 'createdAt'])
@Index('idx_export_task_creator_created', ['createdBy', 'createdAt'])
export class ExportTask {
  @PkColumn()
  id!: number;

  /** 展示用任务号，与 id 一一对应（如 EXP20261121000001） */
  @Column({ name: 'task_no', type: 'varchar', length: 48, comment: '任务号（展示用）' })
  taskNo!: string;

  /** 导出类型：orders / operation-logs（新增类型只需在导出服务注册一个生成器） */
  @Column({ type: 'varchar', length: 48, comment: '导出类型' })
  kind!: string;

  /** 列表展示用中文名 */
  @Column({ type: 'varchar', length: 96, comment: '导出类型中文名' })
  label!: string;

  /** 提交时的筛选条件原文（JSON 文本）—— 复现这次导出靠它，不靠猜 */
  @Column({ name: 'filter_json', type: 'text', nullable: true, comment: '筛选条件原文（JSON）' })
  filterJson?: string | null;

  /** pending / running / done / failed */
  @Column({ type: 'varchar', length: 16, default: 'pending', comment: '作业状态' })
  status!: string;

  /** 实际导出行数（完成后写入；失败为 0） */
  @Column({ name: 'row_count', type: 'int', default: 0, comment: '导出行数' })
  rowCount!: number;

  /** 产物在 StorageProvider 中的 key（done 时非空） */
  @Column({
    name: 'file_key',
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: '产物存储 key',
  })
  fileKey?: string | null;

  /** 建议下载文件名（含 BOM 的 CSV，Excel 直接打开） */
  @Column({
    name: 'file_name',
    type: 'varchar',
    length: 255,
    nullable: true,
    comment: '下载文件名',
  })
  fileName?: string | null;

  /** 失败原因（仅 failed 态有值） */
  @Column({ type: 'text', nullable: true, comment: '失败原因' })
  error?: string | null;

  /** 提交人 admin_user.id */
  @Column({
    name: 'created_by',
    type: 'bigint',
    transformer: bigintTransformer,
    nullable: true,
    comment: '提交人 admin_user.id',
  })
  createdBy?: number | null;

  /** 提交人姓名快照（账号改名不影响历史任务归属展示） */
  @Column({
    name: 'created_name',
    type: 'varchar',
    length: 64,
    nullable: true,
    comment: '提交人姓名快照',
  })
  createdName?: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', precision: 3 })
  createdAt!: Date;

  /** 完成/失败时刻（pending / running 为 NULL） */
  @Column({
    name: 'finished_at',
    type: 'datetime',
    precision: 3,
    nullable: true,
    comment: '结束时刻',
  })
  finishedAt?: Date | null;
}
