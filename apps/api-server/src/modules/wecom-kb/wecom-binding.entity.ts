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
