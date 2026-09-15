// 必须最先执行：Entity 的列类型在「模块加载期」就依赖 process.env.DB_DRIVER
// （见 entities/transformers.ts 的 PkColumn），晚于 AppModule 加载就会读到默认值。
import 'dotenv/config';

import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { resolve } from 'path';

import { AppModule } from './app.module';
import { requestIdMiddleware } from './common/middleware/request-id.middleware';

async function bootstrap() {
  // rawBody: 微信支付 V3 回调需用**原始报文**验签（/pay/notify）
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: true,
    rawBody: true,
  });

  const cfg = app.get(ConfigService);

  // 请求链路 ID（《接口规范》§1.2）：优先沿用 X-Request-Id，缺省服务端生成
  app.use(requestIdMiddleware);

  const prefix = cfg.get<string>('app.apiPrefix') ?? '/api/v1';
  app.setGlobalPrefix(prefix);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  // STORAGE_DRIVER=local 时暴露本地静态目录，供图片直链访问
  if (cfg.get<string>('app.drivers.storage') === 'local') {
    const rawDir = cfg.get<string>('storage.local.dir') ?? './data/uploads';
    const dir = resolve(process.cwd(), '..', '..', rawDir);
    app.useStaticAssets(dir, { prefix: '/static/' });
    Logger.log(`静态目录已挂载：/static/ → ${dir}`, 'Bootstrap');
  }

  // Swagger（开发期 /docs）
  const config = new DocumentBuilder()
    .setTitle('ABox 一盒 · API')
    .setDescription('办公楼白领团餐平台接口 —— 契约见 docs/ABox一盒接口规范v1.0.md')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, config));

  const port = cfg.get<number>('app.port') ?? 3000;
  await app.listen(port);

  const d = cfg.get<{ db: string; queue: string; storage: string; providerMode: string }>(
    'app.drivers',
  ) ?? { db: '?', queue: '?', storage: '?', providerMode: '?' };
  Logger.log(`API 已启动：http://localhost:${port}${prefix}  Swagger: /docs`, 'Bootstrap');
  Logger.log(
    `驱动：db=${d.db} · queue=${d.queue} · storage=${d.storage} · provider=${d.providerMode}`,
    'Bootstrap',
  );
  if (d.providerMode === 'mock') {
    Logger.warn(
      '当前为 MOCK 模式：登录用 code=dev:1001；支付成功自动回调（可关 MOCK_PAY_AUTO_SUCCESS）',
      'Bootstrap',
    );
  }
}

void bootstrap();
