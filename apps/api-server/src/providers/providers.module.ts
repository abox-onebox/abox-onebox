import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  StorageProvider,
  STORAGE_PROVIDER,
  PendingCloudStorageProvider,
} from './storage/storage.provider';
import { LocalStorageProvider } from './storage/local-storage.provider';
import { FlexPayoutProvider, FLEX_PAYOUT_PROVIDER } from './flex-payout/flex-payout.provider';
import { MockFlexPayoutProvider } from './flex-payout/mock-flex-payout.provider';
import { WX_MINI_PROVIDER, WxMiniProvider } from './wx-mini/wx-mini.provider';
import { MockWxMiniProvider } from './wx-mini/mock-wx-mini.provider';
import { RealWxMiniProvider } from './wx-mini/real-wx-mini.provider';
import { WX_PAY_PROVIDER, WxPayProvider } from './wx-pay/wx-pay.provider';
import { MockWxPayProvider } from './wx-pay/mock-wx-pay.provider';
import { RealWxPayProvider } from './wx-pay/real-wx-pay.provider';
import {
  WX_NOTIFY_PROVIDER,
  WxNotifyProvider,
  MockWxNotifyProvider,
} from './wx-notify/wx-notify.provider';
import { RealWxNotifyProvider } from './wx-notify/real-wx-notify.provider';

/**
 * 外部依赖模块（全局）
 *
 * 按环境变量在 mock / real 之间切换，业务代码只依赖抽象类型，**不判断模式**：
 *   PROVIDER_MODE=mock → 无需任何真实账号即可跑通全链路（本地开发）
 *   PROVIDER_MODE=real → 走真实微信小程序 / 微信支付 / 灵活用工平台（云端）
 *   STORAGE_DRIVER     → local 零依赖；cos/minio 需补依赖后启用
 */
@Global()
@Module({
  providers: [
    {
      provide: WX_MINI_PROVIDER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): WxMiniProvider =>
        cfg.get<string>('app.drivers.providerMode') === 'real'
          ? new RealWxMiniProvider(cfg)
          : new MockWxMiniProvider(cfg),
    },
    {
      provide: WX_PAY_PROVIDER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): WxPayProvider =>
        cfg.get<string>('app.drivers.providerMode') === 'real'
          ? new RealWxPayProvider(cfg)
          : new MockWxPayProvider(cfg),
    },
    {
      provide: WX_NOTIFY_PROVIDER,
      inject: [ConfigService],
      /**
       * ⚠️ 2026-11-18 修正：此前这里**无条件**返回 `MockWxNotifyProvider`，
       * 连 `PROVIDER_MODE` 都没读。后果是线上 6 个已接线的订阅场景
       * （退款结果 / 佣金入账 / 截单提醒 / 团长申请 / 楼宇停供履约 / 停供退款）
       * 全部「投递成功」：`ab_message` 写满 `status=success`，微信侧一条都没收到。
       *
       * 这类假成功比报错更难发现 —— 日志有记录、业务不报错、用户只是"没收到"，
       * 而一张全是 success 的表不会引起任何人怀疑。故与其他四个通道统一口径：
       * **real 走真实发送，mock 才打日志**。
       */
      useFactory: (cfg: ConfigService): WxNotifyProvider =>
        cfg.get<string>('app.drivers.providerMode') === 'real'
          ? new RealWxNotifyProvider(cfg)
          : new MockWxNotifyProvider(),
    },
    {
      provide: FLEX_PAYOUT_PROVIDER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): FlexPayoutProvider => new MockFlexPayoutProvider(cfg),
    },
    {
      provide: STORAGE_PROVIDER,
      inject: [ConfigService],
      useFactory: (cfg: ConfigService): StorageProvider => {
        const driver = cfg.get<string>('app.drivers.storage') ?? 'local';
        return driver === 'local'
          ? new LocalStorageProvider(cfg)
          : new PendingCloudStorageProvider(driver as 'cos' | 'minio');
      },
    },
  ],
  exports: [
    WX_MINI_PROVIDER,
    WX_PAY_PROVIDER,
    WX_NOTIFY_PROVIDER,
    FLEX_PAYOUT_PROVIDER,
    STORAGE_PROVIDER,
  ],
})
export class ProvidersModule {}
