import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, JwtPayload, Public } from '../../common/decorators/auth.decorator';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('login')
  @ApiOperation({
    summary: '微信登录',
    description:
      'PROVIDER_MODE=mock 时可用 code=`dev:1001` 指定固定身份反复登录同一账号；real 模式传 wx.login() 的真实 code',
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  @ApiOperation({ summary: '当前登录用户资料（含团长身份）' })
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.profile(user.sub);
  }
}
