/**
 * op 元数据（真源：KB 前端 OPS_CATALOG / QUERY_CATALOG，见 _app/abox-kb/index.html:10503-10596）
 *
 * ⚠️ 这是**后端对指令的路由依据**，与前端目录同源但独立维护——
 *    前端改目录时此处须同步（已在 ABox 项目记忆登记：改 A 照亮 B）。
 *    仅收录「端点 / 方法 / 必填 / 选填」，不含前端 UI 文案。
 *
 * endpoint 中的 `:xxx` 会被 op-proxy 用 params[xxx] 替换（如 :id / :orderNo）。
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT';

export interface OpMeta {
  label: string;
  method: HttpMethod;
  endpoint: string;
  required: string[];
  optional: string[];
}

/** 写类操作（exec / submit / recall 都走这里；high/mid 在 submit 两步流，low 直 exec） */
export const OP_META: Record<string, OpMeta> = {
  create_dish: {
    label: '上架新菜品',
    method: 'POST',
    endpoint: '/admin/dishes',
    required: ['supplierId', 'name', 'category', 'costPriceFen'],
    optional: ['description', 'imageUrl', 'status'],
  },
  batch_dish_status: {
    label: '批量上下架菜品',
    method: 'POST',
    endpoint: '/admin/dishes/batch-status',
    required: ['ids', 'status'],
    optional: ['reason'],
  },
  edit_dish: {
    label: '编辑菜品',
    method: 'PUT',
    endpoint: '/admin/dishes/:id',
    required: ['id'],
    optional: ['name', 'category', 'costPriceFen', 'description', 'imageUrl', 'status'],
  },
  create_meal_template: {
    label: '组合套餐模板',
    method: 'POST',
    endpoint: '/admin/meal/templates',
    required: ['name'],
    optional: ['price', 'kind', 'items', 'sourceSetMealId', 'oneLiner', 'description', 'coverUrl'],
  },
  edit_meal_template: {
    label: '编辑套餐模板',
    method: 'PUT',
    endpoint: '/admin/meal/templates/:id',
    required: ['id'],
    optional: ['name', 'price', 'items', 'kind', 'status'],
  },
  assign_meal: {
    label: '给楼分配套餐',
    method: 'POST',
    endpoint: '/admin/meal/assignments',
    required: ['mealDate', 'buildingGroupId', 'setMealId'],
    optional: ['distributionCenterId'],
  },
  publish_assignment: {
    label: '上架/下架套餐分配',
    method: 'POST',
    endpoint: '/admin/meal/assignments/:id/publish',
    required: ['id', 'action'],
    optional: [],
  },
  edit_assignment: {
    label: '编辑套餐分配',
    method: 'PUT',
    endpoint: '/admin/meal/assignments/:id',
    required: ['id'],
    optional: ['setMealId', 'distributionCenterId'],
  },
  copy_assignment: {
    label: '批量复制套餐分配',
    method: 'POST',
    endpoint: '/admin/meal/assignments/copy',
    required: ['fromDate', 'targetDates'],
    optional: ['buildingGroupIds'],
  },
  change_leader: {
    label: '变更团长',
    method: 'PUT',
    endpoint: '/admin/leaders/:id',
    required: ['id', 'reason'],
    optional: ['level', 'buildingId', 'floor'],
  },
  appoint_leader: {
    label: '任命/转交团长',
    method: 'POST',
    endpoint: '/admin/leaders',
    required: ['userId', 'buildingId', 'realName', 'phone', 'reason'],
    optional: ['level', 'floor', 'transferFromLeaderId'],
  },
  leader_audit: {
    label: '团长资质补录',
    method: 'POST',
    endpoint: '/admin/leaders/:id/audit',
    required: ['id', 'action', 'reason'],
    optional: ['agreementVersion'],
  },
  send_message: {
    label: '群发运营通知',
    method: 'POST',
    endpoint: '/admin/messages/orchestrate',
    required: ['scene', 'audience'],
    optional: ['mealDate', 'dryRun', 'limit'],
  },
  manual_adjust: {
    label: '手动改单',
    method: 'POST',
    endpoint: '/admin/orders/manual-adjust',
    required: ['orderNo', 'action', 'reason'],
    optional: ['quantity', 'buildingId'],
  },
  force_refund: {
    label: '强制退款',
    method: 'POST',
    endpoint: '/admin/orders/:orderNo/force-refund',
    required: ['orderNo', 'reason'],
    optional: ['reasonType', 'amountFen'],
  },
  recall_request: {
    label: '撤回未审批申请',
    method: 'POST',
    endpoint: '/admin/operation-requests/:id/recall',
    required: ['id'],
    optional: ['reason'],
  },
};

/** 只读查数（operator 令牌即可） */
export const QUERY_META: Record<string, OpMeta> = {
  q_orders: {
    label: '订单查询',
    method: 'GET',
    endpoint: '/admin/orders',
    required: [],
    optional: ['date', 'status', 'buildingGroupId'],
  },
  q_dish_heat: {
    label: '菜品热度',
    method: 'GET',
    endpoint: '/admin/stats/dish-heat',
    required: [],
    optional: ['date'],
  },
  q_building_rank: {
    label: '楼栋下单排行',
    method: 'GET',
    endpoint: '/admin/stats/building-rank',
    required: [],
    optional: ['date'],
  },
  q_my_requests: {
    label: '我提交的高危审批进度',
    method: 'GET',
    endpoint: '/admin/operation-requests',
    required: [],
    optional: ['status'],
  },
};

export function lookupOp(opCode: string): OpMeta | undefined {
  return OP_META[opCode];
}
export function lookupQuery(qCode: string): OpMeta | undefined {
  return QUERY_META[qCode];
}
