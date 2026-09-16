import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Message as MessageLog, MessageTemplate } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { MessageService } from './message.service';

/**
 * 消息推送模块 · 见《接口规范 v1.0》§6.7 与《目录结构 v2.0》
 *
 * ## 职责边界（与 `AdminModule` 的分工）
 *
 * | | 谁管 | 干什么 |
 * |---|---|---|
 * | **管理侧** | `admin/template/message-template.service.ts` | D59/D60 读改模板（后台页面用） |
 * | **投递侧** | 本模块 `MessageService` | 业务动作触发时按场景投递 + 落 `ab_message` 日志 |
 *
 * 两侧**共用** `admin/template/message-template.specs.ts` 的场景声明与启用闸门
 * （规则单点），但**不共用 service** —— 读写用途不同，合并会让「谁能改配置」
 * 与「谁能发通知」在同一个类里纠缠。
 *
 * ## ⚠️ 为什么把场景声明放在 `admin/template/` 而不是这里
 *
 * 它是**后台管理清单**的一部分（与 `config.specs.ts` 同侧、同纪律：一份声明驱动
 * 出参结构 / 可写白名单 / 闸门规则 / 页面控件）。若在本模块再放一份 `templates/`，
 * 立刻就有了「模板定义到底写哪」的两个答案。原 `templates/index.ts` 与
 * `wechat-template.service.ts` 两个空占位已在 M3-12 删除。
 */
@Module({
  imports: [TypeOrmModule.forFeature([MessageLog, MessageTemplate, User])],
  providers: [MessageService],
  exports: [MessageService],
})
export class MessageModule {}
