import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminGuard } from '../../common/guards/admin.guard';
import { Roles } from '../../common/decorators/auth.decorator';
import { allItems, canExec, displayName, moduleOf, riskOf } from './op-policy';

/**
 * 后台「功能目录」（只读）· 给「按功能项放权」的勾选面板供数据
 *
 * 为什么不把 131 项硬编码进前端：
 *   目录由 `scripts/gen-wecom-catalog.mjs` 从控制器源码自动生成，端点改名/新增时
 *   前端硬编码会静默过期 —— 管理员看到的是旧清单，勾了却不生效（或勾不到新功能）。
 *   走这个端点，前端每次都拿当前真源。
 *
 * ⚠️ 出参**刻意不含** `source`（源码文件:行号）：那是给门禁核对漂移用的调试信息，
 *    对页面没价值，且暴露内部目录结构。要排查就去看生成器输出。
 * ⚠️ 每条带 `staffBase`：表示「不放权时同事本来就能做」。
 *    页面上必须把这类项与「这次额外给的」分开显示 —— 否则管理员会以为
 *    「我给他开了 40 项」，其实那 40 项他本来就会，真正新增的可能只有 3 项。
 */
@Controller('wecom/kb/ops')
@UseGuards(AdminGuard)
@Roles('super_admin', 'admin')
export class WecomOpsAdminController {
  @Get()
  catalog(): {
    total: number;
    items: Array<{
      code: string;
      label: string;
      method: string;
      path: string;
      module: string;
      risk: string;
      staffBase: boolean;
    }>;
  } {
    const items = allItems()
      .map((it) => ({
        code: it.code,
        label: displayName(it.entry),
        method: it.entry.method,
        path: it.entry.path,
        module: moduleOf(it.entry),
        risk: riskOf(it.entry),
        // 不放权时的可用性（这就是「他本来会不会」的判据，与机器人侧同一函数）
        staffBase: canExec('staff', it.entry, { code: it.code }).ok,
      }))
      .sort((a, b) => a.module.localeCompare(b.module) || a.path.localeCompare(b.path));
    return { total: items.length, items };
  }
}
