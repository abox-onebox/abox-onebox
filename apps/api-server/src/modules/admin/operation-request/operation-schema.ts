/**
 * 高危审批 · 操作参数的结构化字段声明（2026-11-21）
 *
 * ## 为什么要有这一层
 *
 * 改造前，后台「新建高危操作申请」让运营手填一坨 JSON：
 * `{"id":1,"action":"note"}` —— 这是**开发者界面**，不是运营界面。
 * 字段叫什么、哪些必填、合法值有哪些，全靠人记；写错了要到「执行」那一步才炸。
 *
 * 本文件把每个 op 的字段形状写成**服务端权威声明**：
 *   · 前端拿它渲染表单（选了操作类型就出对应字段，不再手敲 JSON）；
 *   · 后端拿它在**提交时**做必填校验（错误前移，不等到执行期才发现）；
 *   · 详情页拿它生成「把谁改成什么」的人话摘要。
 *
 * ## 口径同源纪律
 *
 * 字段依据各目标 DTO（见每个字段的 `dto` 注释）编写；`execute` 仍复用目标 controller
 * 的 DTO 校验，本层**不替代**它 —— 只是把同一套口径提前到提交与展示两端。
 * 声明与 DTO 漂移的表现是「表单能填、执行报错」，故新增 op 时必须同时核对目标 DTO。
 *
 * ## 为什么没有把 11 个 op 的**全部**字段都列进来
 *
 * `suspend_building` / `suspend_building_group` 的 DTO 有十几个可选字段（地址、坐标、楼栋列表等），
 * 全塞进表单会让 90% 的申请被一屏用不到的输入框淹没。这里只列**决定这次操作后果的核心字段**，
 * 其余保留在详情页的「原始 JSON」与新建弹窗的「高级：直接编辑 JSON」里 —— 能力不丢，
 * 但默认路径是清晰的。
 */

export type OpFieldType = 'int' | 'string' | 'text' | 'select' | 'boolean' | 'ints';

export interface OpFieldOption {
  value: string | number;
  label: string;
}

export interface OpField {
  key: string;
  label: string;
  type: OpFieldType;
  required?: boolean;
  options?: OpFieldOption[];
  placeholder?: string;
  /** 摘要里的「操作对象」字段（如订单号 / 团长 ID），只用于人话文案，不参与执行 */
  subject?: boolean;
}

export interface OpSchema {
  opCode: string;
  label: string;
  /** 一句话说明这次操作会改什么，审批人一眼看懂 */
  effect: string;
  fields: OpField[];
}

const STATUS_OPTIONS: OpFieldOption[] = [
  { value: 1, label: '上架 / 启用' },
  { value: 0, label: '下架 / 停用' },
];

/** 全量 11 个可审批操作 —— 与 `operation-request.service.ts` 的 OP_ENDPOINTS 一一对应 */
export const OP_SCHEMAS: OpSchema[] = [
  {
    opCode: 'create_dish',
    label: '上架新菜品',
    effect: '向商品库新增一个菜品',
    fields: [
      { key: 'supplierId', label: '供应商 ID', type: 'int', required: true },
      { key: 'name', label: '菜品名称', type: 'string', required: true },
      {
        key: 'category',
        label: '档位',
        type: 'string',
        required: true,
        placeholder: '如 主菜 / 素菜',
      },
      { key: 'costPriceFen', label: '成本价（分）', type: 'int', required: true },
      { key: 'status', label: '上架状态', type: 'select', options: STATUS_OPTIONS },
      { key: 'description', label: '菜品描述', type: 'text' },
    ],
  },
  {
    opCode: 'batch_dish_status',
    label: '批量上下架菜品',
    effect: '一次改动多个菜品的上下架状态',
    fields: [
      {
        key: 'ids',
        label: '菜品 ID（逗号分隔）',
        type: 'ints',
        required: true,
        placeholder: '如 12,13,14',
        subject: true,
      },
      { key: 'status', label: '目标状态', type: 'select', required: true, options: STATUS_OPTIONS },
      { key: 'reason', label: '变更原因', type: 'string', placeholder: '批量下架必填' },
    ],
  },
  {
    opCode: 'edit_dish',
    label: '编辑菜品',
    effect: '修改一个已有菜品的资料或价格',
    fields: [
      { key: 'id', label: '菜品 ID', type: 'int', required: true, subject: true },
      { key: 'name', label: '菜品名称', type: 'string' },
      { key: 'category', label: '档位', type: 'string' },
      { key: 'costPriceFen', label: '成本价（分）', type: 'int' },
      { key: 'status', label: '上架状态', type: 'select', options: STATUS_OPTIONS },
      { key: 'description', label: '菜品描述', type: 'text' },
    ],
  },
  {
    opCode: 'change_leader',
    label: '变更团长',
    effect: '改团长的等级 / 所属楼 / 楼层',
    fields: [
      { key: 'id', label: '团长 ID', type: 'int', required: true, subject: true },
      { key: 'level', label: '目标等级', type: 'string', placeholder: '如 trainee / formal' },
      { key: 'buildingId', label: '目标办公楼 ID', type: 'int' },
      { key: 'floor', label: '目标楼层', type: 'string' },
      { key: 'reason', label: '变更原因', type: 'string', required: true },
    ],
  },
  {
    opCode: 'appoint_leader',
    label: '任命 / 转交团长',
    effect: '把一个用户任命为团长，或从一位团长转交',
    fields: [
      { key: 'userId', label: '用户 ID', type: 'int', required: true, subject: true },
      { key: 'buildingId', label: '办公楼 ID', type: 'int', required: true },
      { key: 'realName', label: '团长姓名', type: 'string', required: true },
      { key: 'phone', label: '手机号', type: 'string', required: true },
      { key: 'floor', label: '楼层', type: 'string' },
      { key: 'level', label: '等级', type: 'string' },
      { key: 'transferFromLeaderId', label: '转出团长 ID', type: 'int' },
      { key: 'reason', label: '任命原因', type: 'string', required: true },
    ],
  },
  {
    opCode: 'leader_audit',
    label: '团长资质补录',
    effect: '停用 / 恢复团长，或补签协议、补资质备注',
    fields: [
      { key: 'id', label: '团长 ID', type: 'int', required: true, subject: true },
      {
        key: 'action',
        label: '动作',
        type: 'select',
        required: true,
        options: [
          { value: 'suspend', label: '停用' },
          { value: 'restore', label: '恢复在职' },
          { value: 'sign_agreement', label: '协议补签' },
          { value: 'note', label: '资质备注' },
        ],
      },
      { key: 'agreementVersion', label: '协议版本', type: 'string', placeholder: '协议补签时必填' },
      { key: 'reason', label: '原因 / 备注', type: 'string', required: true },
    ],
  },
  {
    opCode: 'send_message',
    label: '群发运营通知',
    effect: '向预定义受众群发一条订阅消息（默认预演不真发）',
    fields: [
      {
        key: 'scene',
        label: '场景键',
        type: 'string',
        required: true,
        subject: true,
        placeholder: '如 cutoff_remind',
      },
      {
        key: 'audience',
        label: '受众选择器',
        type: 'string',
        required: true,
        placeholder: '如 cutoff_remind_pending',
      },
      { key: 'mealDate', label: '目标交付日', type: 'string', placeholder: 'YYYY-MM-DD，缺省明日' },
      { key: 'dryRun', label: '预演（不真发）', type: 'boolean' },
      { key: 'limit', label: '受众上限', type: 'int', placeholder: '默认 500，上限 2000' },
    ],
  },
  {
    opCode: 'manual_adjust',
    label: '手动改单',
    effect: '改一份订单的份数或交付楼',
    fields: [
      { key: 'orderNo', label: '订单号', type: 'string', required: true, subject: true },
      {
        key: 'action',
        label: '改动项',
        type: 'select',
        required: true,
        options: [
          { value: 'change_quantity', label: '改份数（目标值）' },
          { value: 'change_building', label: '改办公楼（目标 ID）' },
        ],
      },
      { key: 'quantity', label: '目标份数', type: 'int', placeholder: '改份数时必填' },
      { key: 'buildingId', label: '目标办公楼 ID', type: 'int', placeholder: '改楼时必填' },
      { key: 'reason', label: '改单原因', type: 'string', required: true },
    ],
  },
  {
    opCode: 'force_refund',
    label: '强制退款',
    effect: '原路退 + 余额退回 + 反向结算，一单整批回滚',
    fields: [
      { key: 'orderNo', label: '订单号', type: 'string', required: true, subject: true },
      { key: 'reasonType', label: '退款类型', type: 'string', placeholder: '如 quality_issue' },
      { key: 'reason', label: '退款原因', type: 'string', required: true },
      { key: 'amountFen', label: '指定金额（分）', type: 'int', placeholder: '留空 = 全额' },
    ],
  },
  {
    opCode: 'suspend_building',
    label: '停用办公楼',
    effect: '停用一栋楼（含未完结订单超限时的强制停用）',
    fields: [
      { key: 'id', label: '办公楼 ID', type: 'int', required: true, subject: true },
      { key: 'status', label: '目标状态', type: 'select', required: true, options: STATUS_OPTIONS },
      { key: 'forceSuspend', label: '强制停用', type: 'boolean' },
      { key: 'suspendReason', label: '停用原因', type: 'string', required: true },
    ],
  },
  {
    opCode: 'suspend_building_group',
    label: '停用楼群',
    effect: '停用一组楼（含未完结订单超限时的强制停用）',
    fields: [
      { key: 'id', label: '楼群 ID', type: 'int', required: true, subject: true },
      { key: 'status', label: '目标状态', type: 'select', required: true, options: STATUS_OPTIONS },
      { key: 'forceSuspend', label: '强制停用', type: 'boolean' },
      { key: 'suspendReason', label: '停用原因', type: 'string', required: true },
    ],
  },
];

const BY_CODE = new Map(OP_SCHEMAS.map((s) => [s.opCode, s]));

export function schemaOf(opCode: string): OpSchema | undefined {
  return BY_CODE.get(opCode);
}

/**
 * 提交时必填校验 —— 只查「必填字段有没有给值」，不重复目标 DTO 的类型/范围校验。
 *
 * 故意做轻：① 知识助手提交的 params 也走这里，过度校验会误伤合法的历史用法；
 * ② 真正的执行校验仍在目标 controller 的 DTO（execute 复用原接口）。
 * 返回人话错误列表，空数组表示通过。
 */
export function validateOpParams(opCode: string, params: unknown): string[] {
  const schema = schemaOf(opCode);
  if (!schema) return [`未知操作类型 ${opCode}`];
  if (!params || typeof params !== 'object' || Array.isArray(params)) return ['参数必须是对象'];
  const p = params as Record<string, unknown>;
  const errors: string[] = [];
  for (const f of schema.fields) {
    if (!f.required) continue;
    const v = p[f.key];
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) {
      errors.push(`${f.label} 必填`);
    }
  }
  return errors;
}
