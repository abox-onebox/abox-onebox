import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * 新建第 38 张表 `ab_export_task` · 后台异步导出任务（2026-11-21）
 *
 * ## 缺口
 * 改造前订单导出是同步 GET：单次 5000 行上限，超了让运营「缩小筛选范围分批导出」；
 * 前端把二维数组拼 CSV，界面卡住且没有任何任务记录。操作日志导出更隐蔽 ——
 * 注释写「导出当前筛选全部命中行」，实现里 `pageSize=total` 却被服务端钳到 100，
 * 实际最多导 100 条且**不报错、不提示截断**。
 *
 * ## 方案
 * 提交导出 → 任务行落库（pending）→ 入队 → 消费者生成文件写 StorageProvider →
 * 回写 done + file_key + row_count。运营在下载中心看进度、取文件、重试失败任务。
 *
 * ## 门禁一致性（schema:parity / index:parity）
 * 列名 / 类型 / 长度 / 默认值 / 索引名与列序须与 `entities/export-task.entity.ts` 逐项一致。
 * `row_count` 而非 `rows`：后者是 SQL 窗口函数关键字，避免MySQL/sqlite两侧解析歧义。
 * 无外键（项目约定）；无 version 列（作业状态单次推进，不争抢资源）。
 *
 * ## 幂等
 * `CREATE TABLE IF NOT EXISTS`；`down()` 对称 `DROP TABLE IF EXISTS`。
 */
const NEW_TABLE = `CREATE TABLE IF NOT EXISTS \`ab_export_task\` (
   \`id\` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
   \`task_no\` VARCHAR(48) NOT NULL COMMENT '任务号（展示用）',
   \`kind\` VARCHAR(48) NOT NULL COMMENT '导出类型',
   \`label\` VARCHAR(96) NOT NULL COMMENT '导出类型中文名',
   \`filter_json\` TEXT DEFAULT NULL COMMENT '筛选条件原文（JSON）',
   \`status\` VARCHAR(16) NOT NULL DEFAULT 'pending' COMMENT '作业状态',
   \`row_count\` INT NOT NULL DEFAULT 0 COMMENT '导出行数',
   \`file_key\` VARCHAR(255) DEFAULT NULL COMMENT '产物存储 key',
   \`file_name\` VARCHAR(255) DEFAULT NULL COMMENT '下载文件名',
   \`error\` TEXT DEFAULT NULL COMMENT '失败原因',
   \`created_by\` BIGINT UNSIGNED DEFAULT NULL COMMENT '提交人 admin_user.id',
   \`created_name\` VARCHAR(64) DEFAULT NULL COMMENT '提交人姓名快照',
   \`created_at\` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
   \`finished_at\` DATETIME(3) DEFAULT NULL COMMENT '结束时刻',
   PRIMARY KEY (\`id\`),
   KEY \`idx_export_task_status_created\` (\`status\`,\`created_at\`),
   KEY \`idx_export_task_creator_created\` (\`created_by\`,\`created_at\`)
 ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台异步导出任务（可追踪、可下载、可重试）'`;

export class ExportTask1700000000027 implements MigrationInterface {
  name = 'ExportTask1700000000027';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(NEW_TABLE);
    console.log('   ↳ ExportTask：建表 ab_export_task（IF NOT EXISTS，重跑幂等）');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `ab_export_task`');
  }
}
