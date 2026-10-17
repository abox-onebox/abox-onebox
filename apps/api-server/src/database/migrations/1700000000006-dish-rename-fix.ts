import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  tableExists,
  columnExists,
  indexExists,
  renameTablePair,
  columnRenameTriple,
  indexRenameTriple,
} from '../migration-utils';
// 改名 SQL 字面量直接复用 1700000000005 导出的同一份（不要复制第二份，避免 schema-parity 解析出重复改名）
import { TABLE_RENAMES, COLUMN_RENAMES, INDEX_RENAMES } from './1700000000005-dish-rename';

/**
 * 补救迁移：`1700000000005` 的**列改名与索引改名被静默跳过**，本支负责补齐
 *
 * ## 为什么会有这支迁移（事故复盘 · 2026-10-15 生产实锤）
 * `1700000000005` 的 `up()` 里，列 / 索引循环曾写成：
 *   ```ts
 *   const [, table, oldC] = columnRenameTriple(sql);   // ✖ 返回的是 [表, 旧列, 新列]
 *   ```
 * 丢弃了第一项（表名），于是判据实际在查「表 `dish_id` 里有没有列 `item_id`」
 * ⇒ 恒为 false ⇒ **6 条列改名 + 10 条索引改名一条都没执行**。
 * 更糟的是它**不抛异常**：TypeORM 照常把该迁移记为已执行，
 * 于是「表改名成功（那段解构是对的）、列名仍是旧的」这种半改状态被永久固化 ——
 * 之后再跑多少次 `deploy.sh` 都不会再补（迁移已标记）。
 *
 * 表现：`ab_set_meal_item` 仍是 `dish_id`，而代码已查 `item_id` ⇒
 * 凡读套餐明细的接口（用户端溯源、后台套餐模板库、下单）在生产一律 90001。
 * 本地没暴露，是因为 e2e 用 sqlite **由实体同步建表**（列名天然是新的），
 * 迁移在 sqlite 上根本不跑 —— 这正是「门禁全绿 ≠ 生产可用」的又一例。
 *
 * ## 本支做什么
 * 复用 `1700000000005` 导出的同一份字面量 SQL（**不复制第二份**，避免 schema-parity
 * 解析出重复改名），逐项查 `information_schema` 后补齐：
 *   · 表改名（已改则跳过）
 *   · 列改名 dish_id→item_id / dish_name→item_name（已改则跳过）
 *   · 索引改名（已改则跳过）
 * 全程幂等：对**任何**状态的环境重跑都安全。
 *
 * ⚠️ 生产处置（2026-10-15）：列改名已由 DBA 式手工 ALTER 补齐并验证，
 *    本支在生产上跑会因「旧列不存在」而全部跳过 —— 这正是期望行为。
 *    它真正保护的是**还没跑过修复版 0005 的其他环境**。
 */
export class DishRenameFix1700000000006 implements MigrationInterface {
  name = 'DishRenameFix1700000000006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    let tables = 0;
    let columns = 0;
    let indexes = 0;

    for (const sql of TABLE_RENAMES) {
      const [oldT, newT] = renameTablePair(sql);
      const hasOld = await tableExists(queryRunner, oldT);
      const hasNew = await tableExists(queryRunner, newT);
      if (hasOld && !hasNew) {
        await queryRunner.query(sql);
        tables += 1;
      }
    }

    for (const sql of COLUMN_RENAMES) {
      // ⚠️ 解构是 [表, 旧列, 新列] —— 0005 正是错在这里（写成 [, table, oldC]）
      const [table, oldC] = columnRenameTriple(sql);
      if (await columnExists(queryRunner, table, oldC)) {
        await queryRunner.query(sql);
        columns += 1;
      }
    }

    for (const sql of INDEX_RENAMES) {
      const [table, oldI] = indexRenameTriple(sql);
      if (await indexExists(queryRunner, table, oldI)) {
        await queryRunner.query(sql);
        indexes += 1;
      }
    }

    console.log(
      `   ↳ DishRenameFix：改名表 ${tables} / 改列 ${columns} / 改名索引 ${indexes}` +
        `（已就位的项跳过；重跑幂等）`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const sql of INDEX_RENAMES) {
      const [table, oldI, newI] = indexRenameTriple(sql);
      if (await indexExists(queryRunner, table, oldI)) {
        await queryRunner.query(`ALTER TABLE \`${table}\` RENAME INDEX \`${newI}\` TO \`${oldI}\``);
      }
    }

    for (const sql of COLUMN_RENAMES) {
      const [table, oldC, newC] = columnRenameTriple(sql);
      if (await columnExists(queryRunner, table, newC)) {
        const reverse = sql.replace(
          new RegExp(`CHANGE \`${oldC}\` \`${newC}\``, 'g'),
          `CHANGE \`${newC}\` \`${oldC}\``,
        );
        await queryRunner.query(reverse);
      }
    }

    for (const sql of TABLE_RENAMES) {
      const [oldT, newT] = renameTablePair(sql);
      const hasOld = await tableExists(queryRunner, oldT);
      const hasNew = await tableExists(queryRunner, newT);
      if (hasOld && !hasNew) {
        await queryRunner.query(`RENAME TABLE \`${oldT}\` TO \`${newT}\``);
      }
    }
  }
}
