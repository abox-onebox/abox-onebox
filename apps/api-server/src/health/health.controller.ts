import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { Public } from '../common/decorators/auth.decorator';

@ApiTags('系统')
@Controller('health')
export class HealthController {
  @Public()
  @Get()
  @ApiOperation({ summary: '健康检查（免鉴权）' })
  check() {
    return { status: 'ok', service: 'abox-api', ts: Date.now() };
  }
}
