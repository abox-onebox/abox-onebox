import { Injectable } from '@nestjs/common';

import {
  ADMIN_ROLES,
  MENU_WILDCARD,
  ROLE_LABEL,
  ROLE_MENUS,
  menusOf,
} from '../../../common/constants/admin-role';
import { ErrorCode } from '../../../common/constants/error-code';
import { BizException } from '../../../common/exceptions/biz.exception';

/** 角色矩阵行 */
export interface AdminRoleRow {
  role: string;
  label: string;
  /** 菜单 key；`['*']` 表示全量（super_admin） */
  menus: string[];
  /** 菜单数量；-1 = 全量通配 */
  menuCount: number;
  /** 是否系统内置角色（一期全部为 true —— 无自建角色，见 admin-role.ts §一期口径） */
  isSystem: boolean;
}

/**
 * 角色与权限 · D54 只读矩阵 / D55 权限调整
 *
 * ## 一期口径
 * 角色菜单映射**定义在代码**（`common/constants/admin-role.ts`），没有 `ab_admin_role`
 * 表。因此 D55「权限调整」一期**有意不做**：直接抛 `10001` 并给出可行路径
 * （去 D53 调整账号角色），而不是返回一个「保存成功」的假象 ——
 * 后台权限改了却不生效，比明确不支持危险得多。
 *
 * 二期若要做在线自定义角色：新增 `ab_admin_role` 表 + 本文件降级为默认种子，
 * 此时 D54/D55 无需改契约，只换数据源。
 */
@Injectable()
export class AdminRoleService {
  /** D54 角色与权限矩阵（只读） */
  async matrix(): Promise<{ list: AdminRoleRow[]; note: string }> {
    const list: AdminRoleRow[] = ADMIN_ROLES.map((role) => {
      const menus = menusOf(role);
      return {
        role,
        label: ROLE_LABEL[role] ?? role,
        menus,
        menuCount: menus.includes(MENU_WILDCARD) ? -1 : menus.length,
        isSystem: true,
      };
    });

    return {
      list,
      note:
        '一期角色与菜单由服务端代码定义（common/constants/admin-role.ts），' +
        '不支持在线新增角色或改动菜单；需要调整权限请到「账号管理」修改具体账号的角色。',
    };
  }

  /** D55 权限调整 —— 一期明确不支持（见类注释） */
  async updateRole(_role: string): Promise<never> {
    throw new BizException(
      ErrorCode.PARAM_INVALID,
      '一期不支持在线调整角色菜单（菜单由服务端代码定义）；请改用「账号管理」修改账号所属角色',
    );
  }

  /** 供账号管理页做「角色 → 菜单」预览 */
  menusOfRole(role: string): string[] {
    return menusOf(role);
  }

  /** 角色是否存在（白名单校验用） */
  isKnownRole(role: string): boolean {
    return Object.prototype.hasOwnProperty.call(ROLE_MENUS, role);
  }
}
