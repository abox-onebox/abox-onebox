/**
 * 供应商资质判据（**唯一真源** · 2026-10-03 抽出）
 *
 * ## 为什么要抽出来
 * `licenseStateOf()` 原本在 `supplier.service` / `supplier-admin.service` /
 * `finance/supplier-share.service` **各写了一份**（三份逐字相同的实现），
 * `canServe()` 则在 `supplier.service`（S1 出餐前置）与本次新增的资质墙各判一次。
 *
 * 「同一判据多处实现」在本项目的后果已经反复出现过：改一边、漏一边，
 * 表现为「A 页面说合格、B 页面说不合格」，且**两边都没报错**。
 * 资质判据尤其危险 —— 它同时决定「能不能出餐」和「能不能上资质墙」，
 * 一旦漂移，就会出现「这家今天确实在出餐，资质墙里却查不到它」。
 *
 * ⚠️ 尚未收口：`supplier-admin.service:613` 与 `supplier-share.service:616`
 *    的两份 `licenseStateOf` **仍未改**为调用本函数（属既有债务，改动面较大，
 *    已登记为待办）。本文件是本判据的**唯一真源**，新增调用一律走这里。
 *
 * ## ⭐ 判据里的一个反直觉点（勿改）
 * `licenseExpireAt` 为 `null` 时 `licenseStateOf` 返回 `UNKNOWN`，
 * 而 `canServeSupplier` 只排除 `EXPIRED` ⇒ **未登记有效期仍视为可在供**。
 * 这不是疏漏：`license_expire_at` 可空是**为兼容历史行**（见实体头注），
 * 把「没登记」当「已过期」会让历史供应商一夜之间全部停摆。
 * 真正拦住它们的是运营在后台的登记动作，不是这一行判据。
 */
import {
  LICENSE_EXPIRING_DAYS,
  LicenseState,
  SupplierAuditStatus,
  SupplierStatus,
} from '@abox/shared-types';

import { addDays, todayBj } from './time';

/**
 * 判据所需的最小结构（duck typing，避免本文件反向依赖 ORM 实体）
 *
 * ⚠️ 故意不 `import type { Supplier }`：通用工具一旦依赖实体，
 * 实体改一个列名就会把工具一起拖进编译错误里，而本文件只需要三个字段。
 */
export interface ServableSupplier {
  status: number;
  auditStatus: string;
  licenseExpireAt?: string | null;
}

/** 证照有效期档位（派生值，不落库）—— 与 D23/D25/资质墙同一口径 */
export function licenseStateOf(expire?: string | null): LicenseState {
  if (!expire) return LicenseState.UNKNOWN;
  const today = todayBj();
  if (expire < today) return LicenseState.EXPIRED;
  if (expire <= addDays(today, LICENSE_EXPIRING_DAYS)) return LicenseState.EXPIRING;
  return LicenseState.NORMAL;
}

/** 出餐前置 ∧ 资质墙上架判据：合作中 ∧ 资质已通过 ∧ 证照未过期 */
export function canServeSupplier(s: ServableSupplier): boolean {
  return (
    s.status === SupplierStatus.ACTIVE &&
    s.auditStatus === SupplierAuditStatus.APPROVED &&
    licenseStateOf(s.licenseExpireAt) !== LicenseState.EXPIRED
  );
}
