import { applyDecorators, SetMetadata } from '@nestjs/common';

/**
 * 操作日志元数据
 * @param module 模块名（与《接口规范》§六 的小节对应，如 'order' / 'supplier' / 'finance'）
 * @param action 操作类型（动宾短语，如 '审批退款' / '更新结算账户' / '停用账号'）
 * @param target 从请求里取对象 ID 的参数名（默认按 `id` → `orderNo` 顺序猜）
 */
export interface OperationLogMeta {
  module: string;
  action: string;
  /** 显式指定路径参数名（如 'orderNo'）；不写则按 id/orderNo/leaderId 顺序取第一个有值的 */
  targetParam?: string;
}

export const OPERATION_LOG_KEY = 'abox:operationLog';

/**
 * 声明式操作日志（写入 `ab_operation_log`，D56 可查）
 *
 * 用法：
 *   ```ts
 *   @OperationLog({ module: 'order', action: '审批退款' })
 *   @Post('orders/:orderNo/approve-refund')
 *   approve(...) {}
 *   ```
 *
 * ⚠️ **只标在「写操作」上**。`GET` 不标 —— 否则列表接口会把数据库刷成日志表。
 * ⚠️ 实现是**全局拦截器**（`OperationLogInterceptor`，注册在 CommonModule），
 *    本装饰器只负责打元数据；这样各业务模块不必 import OperationLog 实体。
 * ⚠️ `request_data` 中的口令类字段会被自动脱敏（见拦截器 REDACT_KEYS）。
 */
export const OperationLog = (meta: OperationLogMeta) =>
  applyDecorators(SetMetadata(OPERATION_LOG_KEY, meta));
