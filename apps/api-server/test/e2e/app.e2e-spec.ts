import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';

describe('App (e2e) · 占位', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('占位：开发阶段补健康检查与主链路 e2e', () => {
    expect(app).toBeDefined();
  });
});
