import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { CurrentUser, JwtPayload, Public } from '../../common/decorators/auth.decorator';
import { AuthService } from './auth.service';
import { AdminLoginDto, RefreshTokenDto } from './dto/admin-login.dto';
import { LoginDto } from './dto/login.dto';

/** 鉴权模块 · A1–A5，见《接口规范 v1.0》§二 */
@ApiTags('认证')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // ---------------------------------------------------------------- 小程序侧

  @Public()
  @Post('login')
  @ApiOperation({
    summary: 'A1 微信登录',
    description:
      'PROVIDER_MODE=mock 时可用 code=`dev:1001` 指定固定身份反复登录同一账号；real 模式传 wx.login() 的真实 code',
  })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Get('me')
  @ApiOperation({ summary: '当前登录用户资料（含团长身份）—— 小程序端便捷别名' })
  me(@CurrentUser() user: JwtPayload) {
    return this.authService.profile(user.sub);
  }

  // ---------------------------------------------------------------- 后台侧

  @Public()
  @Post('admin-login')
  @ApiOperation({
    summary: 'A2 后台登录（运营 / 供应商同一入口，按账号角色返回 menus）',
    description:
      '开发期种子账号：admin/admin123（super_admin）· finance/finance123（finance）· sanweiwu/supplier123（supplier）',
  })
  adminLogin(@Body() dto: AdminLoginDto) {
    return this.authService.adminLogin(dto);
  }

  @Public()
  @Post('refresh')
  @ApiOperation({
    summary: 'A3 刷新令牌（一期仅服务后台账号）',
    description:
      '小程序 A1 出参虽预留 refreshToken，但端上暂未实现刷新时机，故本接口一期只接受 typ=admin 的刷新令牌。' +
      '用 access token 调本接口会被拒（否则等于永不过期）。',
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.authService.adminRefresh(dto);
  }

  @Post('logout')
  @ApiOperation({
    summary: 'A4 登出（无状态，仅前端清态；服务端不吊销令牌）',
  })
  logout() {
    return this.authService.adminLogout();
  }

  @Get('profile')
  @ApiOperation({
    summary: 'A5 当前登录者 —— 按主体类型分流（user → 用户资料；admin → 账号 + menus）',
  })
  profile(@CurrentUser() me: JwtPayload) {
    return me.typ === 'admin'
      ? this.authService.adminProfile(me.sub)
      : this.authService.profile(me.sub);
  }
}
