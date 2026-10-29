import { FindOperator } from 'typeorm';

import { ErrorCode } from '../../src/common/constants/error-code';
import { DeliveryProof, DeliveryRecord } from '../../src/database/entities/order.entity';
import { DeliveryService } from '../../src/modules/delivery/delivery.service';

/**
 * Q3 · 凭证写入口的**服务级**证据（2026-10-29）
 *
 * 与 `delivery-proof.spec.ts` 的分工：那份测**判据纯函数**（什么样的 url 能进库），
 * 这份测**编排**（校验顺序、归属校验、软删语义、计数是否说真话）。
 *
 * ⭐ 为什么必须补这份：`DeliveryService` **全仓没有单测**，而 Q3 的三个写入口里
 *    有两个是「看起来对、错了也不报错」的形状 ——
 *    ① `aliveCount` 若从当次结果里 filter，`scope=deleted` 时必然是 0
 *       （一个「看着算过、实际恒为 0」的数）；
 *    ② 撤销若只按 `id` 查，拿 A 单的凭证 id 去撤 B 单会**成功**。
 *    这两处没有任何机械检查会拦，只能靠测试。
 */

/** 假凭证仓储：按 `IsNull()` / `Not(IsNull())` 真实过滤（否则软删语义测不出来） */
class FakeProofRepo {
  rows: Array<Partial<DeliveryProof> & { id?: number }> = [];
  seq = 1;

  create(p: Partial<DeliveryProof>) {
    return { ...p } as DeliveryProof;
  }

  async save(e: DeliveryProof) {
    if (!e.id) {
      e.id = this.seq++;
      e.createdAt = new Date();
    }
    const i = this.rows.findIndex((r) => r.id === e.id);
    if (i >= 0) this.rows[i] = e;
    else this.rows.push(e);
    return e;
  }

  async count(opts: { where: Record<string, unknown> }) {
    return this.match(opts.where).length;
  }

  async find(opts: { where: Record<string, unknown> }) {
    return this.match(opts.where).sort((a, b) => (a.id ?? 0) - (b.id ?? 0)) as DeliveryProof[];
  }

  /** `revokeProof` 用它做 `(id, deliveryRecordId, deletedAt IS NULL)` 三条件定位 */
  async findOne(opts: { where: Record<string, unknown> }) {
    const hit = this.match(opts.where)[0];
    return (hit ?? null) as DeliveryProof | null;
  }

  async update(where: { id: number }, patch: Partial<DeliveryProof>) {
    const r = this.rows.find((x) => x.id === where.id);
    if (r) Object.assign(r, patch);
    return { affected: r ? 1 : 0 };
  }

  private match(where: Record<string, unknown>) {
    return this.rows.filter((r) => {
      if (where.deliveryRecordId !== undefined && r.deliveryRecordId !== where.deliveryRecordId) {
        return false;
      }
      if (where.id !== undefined && r.id !== where.id) return false;
      const d = where.deletedAt;
      if (d instanceof FindOperator) {
        if (d.type === 'isNull') return r.deletedAt == null;
        if (d.type === 'not') return r.deletedAt != null;
      }
      return true;
    });
  }
}

/** 假配送单仓储：只有 id=1 存在（用来验证「不存在 → 30017」与「越界 → 30025」） */
class FakeDeliveryRepo {
  constructor(private readonly existing: number[] = [1]) {}
  async findOne(opts: { where: { id: number } }) {
    if (!this.existing.includes(opts.where.id)) return null;
    return {
      id: opts.where.id,
      mealDate: '2026-10-29',
      buildingGroupId: 7,
      status: 'arrived',
    } as DeliveryRecord;
  }
}

const makeSvc = (proofs = new FakeProofRepo(), deliveries = new FakeDeliveryRepo()) =>
  new DeliveryService(
    null as never,
    deliveries as never,
    null as never,
    null as never,
    null as never,
    proofs as never,
  );

const expectBiz = async (fn: () => Promise<unknown>, code: ErrorCode) => {
  await expect(fn()).rejects.toMatchObject({ code });
};

describe('Q3 addProof', () => {
  it('正常：写库 + uploadedBy 记到操作人头上 + 回显中文类型', async () => {
    const proofs = new FakeProofRepo();
    const svc = makeSvc(proofs);

    const r = await svc.addProof(
      1,
      { url: '/static/uploads/2026-10-29/a.jpg', kind: 'sign', remark: '  B 座前台  ' },
      42,
    );

    expect(proofs.rows).toHaveLength(1);
    expect(proofs.rows[0].deliveryRecordId).toBe(1);
    expect(proofs.rows[0].uploadedBy).toBe(42);
    expect(proofs.rows[0].remark).toBe('B 座前台'); // trim 过
    expect(r.proof.kindText).toBe('签收单');
    expect(r.aliveCount).toBe(1);
  });

  it('kind 非法 → 静默取缺省，不报错（类型只是标签，不该拦住上传）', async () => {
    const svc = makeSvc();
    const r = await svc.addProof(1, { url: '/static/a.jpg', kind: 'receipt' }, 1);
    expect(r.proof.kind).toBe('photo');
    expect(r.proof.kindText).toBe('现场照');
  });

  it('⛔ url 非法 → 拒，**且不写库**（空 url 会造出「列表显示有凭证、打开是空白」的假状态）', async () => {
    const proofs = new FakeProofRepo();
    const svc = makeSvc(proofs);

    await expectBiz(
      () => svc.addProof(1, { url: 'javascript:alert(1)' }, 1),
      ErrorCode.PARAM_INVALID,
    );
    await expectBiz(() => svc.addProof(1, { url: '   ' }, 1), ErrorCode.PARAM_INVALID);
    expect(proofs.rows).toHaveLength(0);
  });

  it('⛔ 配送单不存在 → 30017 且不写库（否则会造出在任何列表里都看不见的孤儿行）', async () => {
    const proofs = new FakeProofRepo();
    const svc = makeSvc(proofs);
    await expectBiz(
      () => svc.addProof(999, { url: '/static/a.jpg' }, 1),
      ErrorCode.DELIVERY_NOT_FOUND,
    );
    expect(proofs.rows).toHaveLength(0);
  });
});

describe('Q3 listProofs', () => {
  const seed = async () => {
    const proofs = new FakeProofRepo();
    const svc = makeSvc(proofs);
    await svc.addProof(1, { url: '/static/a.jpg' }, 1);
    await svc.addProof(1, { url: '/static/b.jpg' }, 1);
    await svc.revokeProof(1, 1, 1); // 撤掉第一张
    return { proofs, svc };
  };

  it('scope=alive 只返有效；scope=deleted 只返已撤销；all 都返', async () => {
    const { svc } = await seed();

    const alive = await svc.listProofs(1, { scope: 'alive' });
    expect(alive.list.map((p) => p.id)).toEqual([2]);
    expect(alive.count).toBe(1);

    const deleted = await svc.listProofs(1, { scope: 'deleted' });
    expect(deleted.list.map((p) => p.id)).toEqual([1]);
    expect(deleted.list[0].revokedAt).not.toBeNull();

    const all = await svc.listProofs(1, { scope: 'all' });
    expect(all.count).toBe(2);
  });

  it('⭐ aliveCount 恒为真实值 —— 即使 scope=deleted 也不是 0（防「看着算过、实际恒为 0」）', async () => {
    const { svc } = await seed();
    for (const scope of ['alive', 'deleted', 'all']) {
      const r = await svc.listProofs(1, { scope });
      expect(r.aliveCount).toBe(1);
    }
    // 缺省 scope（不传）也必须是 alive 语义
    expect((await svc.listProofs(1, {})).aliveCount).toBe(1);
    // 非法 scope → 回落 alive，而不是「什么都返回」
    expect((await svc.listProofs(1, { scope: 'weird' })).scope).toBe('alive');
  });

  it('配送单不存在 → 30017', async () => {
    const svc = makeSvc();
    await expectBiz(() => svc.listProofs(999, {}), ErrorCode.DELIVERY_NOT_FOUND);
  });
});

describe('Q3 revokeProof（软删）', () => {
  const seedOne = async () => {
    const proofs = new FakeProofRepo();
    const svc = makeSvc(proofs);
    await svc.addProof(1, { url: '/static/a.jpg' }, 1);
    return { proofs, svc };
  };

  it('正常撤销：行仍在（软删）、aliveCount 归零、有撤销时刻', async () => {
    const { proofs, svc } = await seedOne();
    const r = await svc.revokeProof(1, 1, 9);

    expect(r.aliveCount).toBe(0);
    expect(r.revokedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // ⭐ 行必须还在 —— 「曾有一张被撤掉的凭证」本身是要查的
    expect(proofs.rows).toHaveLength(1);
    expect(proofs.rows[0].deletedAt).toBeInstanceOf(Date);
  });

  it('⛔ 越界：拿别的配送单的凭证 id 来撤 → 30025（按 (id, deliveryId) 双条件定位）', async () => {
    // ⚠️ 配送单 2 **必须存在**：否则先命中「单不存在」(30017)，
    //    测到的就不是越界这一档了（本用例第一版正是在这里写错，白跑一次）。
    const proofs = new FakeProofRepo();
    const svc = makeSvc(proofs, new FakeDeliveryRepo([1, 2]));
    await svc.addProof(1, { url: '/static/a.jpg' }, 1);

    // 凭证 id=1 属于配送单 1，这里假装它属于 2
    await expectBiz(() => svc.revokeProof(2, 1, 9), ErrorCode.DELIVERY_PROOF_NOT_FOUND);
    // 关键：不能真的被撤掉
    expect(proofs.rows[0].deletedAt).toBeUndefined();
  });

  it('⛔ 已撤销的再撤一次 → 30025（与「不存在」同码，端上不用多分一支）', async () => {
    const { svc } = await seedOne();
    await svc.revokeProof(1, 1, 9);
    await expectBiz(() => svc.revokeProof(1, 1, 9), ErrorCode.DELIVERY_PROOF_NOT_FOUND);
  });

  it('配送单不存在 → 30017（凭证归属之前先确认单在不在）', async () => {
    const svc = makeSvc();
    await expectBiz(() => svc.revokeProof(999, 1, 9), ErrorCode.DELIVERY_NOT_FOUND);
  });
});
