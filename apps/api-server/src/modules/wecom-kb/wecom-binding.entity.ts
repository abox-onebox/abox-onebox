import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * 企业微信用户 ↔ KB 令牌 预绑定（管理员在后台一次性映射）
 *
 * ⚠️ 安全说明：operator_token / approver_token 是**预签发的后台 JWT（明文存储）**。
 *    这是「管理员预绑定」路线 chosen 的固有形态——等同于把 KB 网页上同事手贴的令牌
 *    改由服务端按 userid 托管。风险点：
 *      · 令牌在库中为明文 → 库须按生产密级保护（已是内网 DB）；
 *      · 令牌轮换须管理员重绑（无自动刷新，因签发方是负责人）；
 *      · 建议 operator 令牌仅授予 operator 权限、approver 令牌仅授予审批权限，最小面。
 *    后续若要做「首次粘贴绑定」或「每次指令带令牌」，改 wecom-binding.service 的取令逻辑即可，
 *    本实体结构不变。
 */
@Entity({ name: 'ab_wecom_binding' })
export class WecomBinding {
  /** 企业微信 userid（明文，企业微信回调里 FromUserName 即此值） */
  @PrimaryColumn({ name: 'userid', type: 'varchar', length: 64 })
  userId!: string;

  /** 操作人姓名 / 工号（透传给后台 X-KB-Operator，对应 KB 网页「操作人」字段） */
  @Column({ name: 'operator_name', type: 'varchar', length: 64, nullable: false })
  operatorName!: string;

  /**
   * 身份等级，决定机器人用哪个执行账号：
   *   · `owner` → 后台 `admin` 角色账号，131 个端点全可达（负责人本人）
   *   · `staff` → 后台 `operator` 角色账号，69 个可达，其余由后台 @Roles 拦下
   *
   * ⚠️ 默认 `staff` 是**最小权限**的刻意选择：新绑定不该天生带 admin 能力。
   */
  @Column({ name: 'tier', type: 'varchar', length: 16, default: 'staff' })
  tier!: 'owner' | 'staff';

  /**
   * 单独放权的端点编码清单（只对 `staff` 生效，`owner` 忽略）。
   *
   * 语义是「加号」而不是「减号」：`null` / `[]` = 没放权，同事只保留 operator 角色本来的能力；
   * 填了编码 = 这些端点**额外**允许他做（执行身份同时升到 owner 账号，否则后台 @Roles 会挡）。
   *
   * ⚠️ 用 `simple-json`（底层 TEXT）而不是 MySQL `json`：值只有「编码数组」这一种形态，
   *    不需要在库里做 JSON 查询，换成 json 类型只会给迁移和驱动版本增加不必要的一致性问题。
   */
  @Column({ name: 'granted_ops', type: 'simple-json', nullable: true })
  grantedOps?: string[] | null;

  /** operator 权限令牌（执行 / 提交 / 撤回 / 查询用） */
  @Column({ name: 'operator_token', type: 'varchar', length: 512, nullable: true })
  operatorToken?: string | null;

  /** approver 权限令牌（审批通过 / 拒绝用） */
  @Column({ name: 'approver_token', type: 'varchar', length: 512, nullable: true })
  approverToken?: string | null;

  @Column({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  createdAt?: Date;

  @Column({
    name: 'updated_at',
    type: 'datetime',
    default: () => 'CURRENT_TIMESTAMP',
    onUpdate: 'CURRENT_TIMESTAMP',
  })
  updatedAt?: Date;
}
