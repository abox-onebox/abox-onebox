import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { PageTrack } from '../../database/entities/system.entity';
import { PageDurationEventDto } from './dto/track.dto';

@Injectable()
export class TrackService {
  constructor(
    @InjectRepository(PageTrack)
    private readonly repo: Repository<PageTrack>,
  ) {}

  /**
   * 批量落库（匿名口径）
   *
   * `created_at` 由 `@CreateDateColumn` 自动写入（服务端落库时刻，DATETIME(3)）；
   * enter/leave 用端上毫秒时刻原样透传（时长自洽性不依赖服务端时钟）。
   */
  async recordBatch(events: PageDurationEventDto[]): Promise<{ received: number }> {
    const rows = events.map((e) =>
      this.repo.create({
        page: e.page,
        pageQuery: e.pageQuery ?? null,
        enterAt: e.enterAt,
        leaveAt: e.leaveAt,
        durationMs: e.durationMs,
      }),
    );
    await this.repo.save(rows);
    return { received: rows.length };
  }
}
