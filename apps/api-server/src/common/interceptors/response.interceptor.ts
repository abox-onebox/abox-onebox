import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request } from 'express';
import { Observable, map } from 'rxjs';

import { ApiResponseDto } from '../dto/api-response.dto';

/**
 * 统一响应包装（《接口规范》§1.2）
 * 约定：Controller 只返回「业务数据」，由本拦截器统一包装成
 *   { code: 0, message: 'ok', data, requestId, timestamp }
 * 禁止在 Controller 里手工拼响应体。
 *
 * ── Y批·双字段向后兼容（2026-10-14）────────────────────────────
 * 功能层去餐饮化把出参契约字段由 dish* 改为 item*（dishId→itemId、
 * dishName→itemName、dishCount→itemCount、dishes→items、dishIds→
 * itemIds、dishNames→itemNames、mainDishName→mainItemName，以及
 * confirmedDishCount→confirmedItemCount、unpublishedDishCount→
 * unpublishedItemCount）。为不破坏已上线 / 在途的旧客户端（历史版本
 * 小程序、后台、外部调用方），这里在包装前对业务数据递归注入「旧字段
 * 名」镜像，值与新字段完全相同。下一大版本清理时，只需删除本段镜像
 * 逻辑（LEGACY_KEY_MAP + mirrorLegacyKeys 调用）即可，无需改任何接口。
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponseDto<T>> {
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<ApiResponseDto<T>> {
    const req = context.switchToHttp().getRequest<Request>();
    const requestId = req.requestId ?? '';

    return next.handle().pipe(
      map((data) => {
        const payload = data === undefined ? null : data;
        // 仅在业务数据上注入旧字段镜像（不污染 code/message 等包装层）
        mirrorLegacyKeys(payload);
        return {
          code: 0,
          message: 'ok',
          data: payload as T,
          requestId,
          timestamp: Date.now(),
        };
      }),
    );
  }
}

/**
 * 新字段名 -> 旧字段名（向后兼容镜像）。
 * 仅对「已经改名为 item* / *ItemCount 的契约字段」做镜像；路由 path、
 * 菜单 key、存储 key、枚举名（DishCategory 等）、文件名等身份类标识
 * 不在其内，因它们本就保持不变。
 */
const LEGACY_KEY_MAP: Record<string, string> = {
  itemId: 'dishId',
  itemName: 'dishName',
  itemCount: 'dishCount',
  items: 'dishes',
  itemIds: 'dishIds',
  itemNames: 'dishNames',
  mainItemName: 'mainDishName',
  confirmedItemCount: 'confirmedDishCount',
  unpublishedItemCount: 'unpublishedDishCount',
};

function mirrorLegacyKeys(node: unknown, depth = 0): void {
  if (node == null || typeof node !== 'object' || depth > 24) return;
  if (Array.isArray(node)) {
    for (const el of node) mirrorLegacyKeys(el, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  // 先快照原始 key，避免镜像写入后污染后续遍历
  const originalKeys = Object.keys(obj);
  for (const key of originalKeys) {
    const legacy = LEGACY_KEY_MAP[key];
    if (legacy && !(legacy in obj)) {
      obj[legacy] = obj[key];
    }
  }
  for (const key of originalKeys) {
    mirrorLegacyKeys(obj[key], depth + 1);
  }
}
