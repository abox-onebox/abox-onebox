import { Injectable } from '@nestjs/common';

/** 调度辅助服务（分布式锁：同一 meal_date 只跑一次） */
@Injectable()
export class ScheduleService {}
