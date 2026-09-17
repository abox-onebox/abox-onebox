import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { Message as MessageLog, MessageTemplate } from '../../database/entities/system.entity';
import { User } from '../../database/entities/user.entity';
import { MessageSubscribeController } from './message.controller';
import { MessageSubscribeService } from './message-subscribe.service';
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
 * | **订阅侧** | 本模块 `MessageSubscribeService`（M4-3） | 用户端读「该请求哪些模板授权」（`GET /me/subscribe/templates`） |
 *
 * 三侧**共用** `admin/template/message-template.specs.ts` 的场景声明、启用闸门
 * （`missingForEnable`）与状态换算（`specState`）—— 规则单点，但**不共用 service**：
 * 读写用途不同，合并会让「谁能改配置」「谁能发通知」「端上该请求什么」在同一个类里纠缠。
 *
 * ⚠️ 订阅侧与投递侧读的是**同一张表**，但判断的是**不同的条件**：
 *    投递侧问「能不能发」（启用 + 渠道条件齐备），订阅侧问「能不能让用户授权」
 *    （还要 + 属于用户端场景 + 已接线）。两者都由 specs 里的函数给出，
 *    本模块不自己判断 —— 否则就会出现「端上请求了投递侧不会发的场景」。
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
  controllers: [MessageSubscribeController],
  providers: [MessageService, MessageSubscribeService],
  exports: [MessageService],
})
export class MessageModule {}
