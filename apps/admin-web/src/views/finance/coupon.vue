<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  createCouponDef,
  fetchCouponDefs,
  fetchCouponGrants,
  grantCoupon,
  grantCouponBatch,
  revokeCoupon,
  updateCouponDef,
  COUPON_STATUS_OPTIONS,
  GRANT_SCOPE_OPTIONS,
  OBTAINED_FROM_OPTIONS,
  type CouponDefRow,
  type CouponGrantBatchResult,
  type CouponGrantScope,
  type GrantCouponBatchPayload,
  type CouponValidityType,
  type GrantCouponPayload,
  type UserCouponRow,
} from '@/api/coupon';
import { fetchUserFilterOptions } from '@/api/user';

/**
 * 代金券管理（券种定义 + 手动发券 + 发放记录 · 2026-10-23）
 *
 * ## 三个刻意的设计
 * 1. **「新建券种」与「直接发一张」是两条独立路径** —— 客服补偿往往是「给这个人
 *    补 5 元」的一次性动作，硬要先建券种再发会多两步、还会在券种表里堆一堆只用过
 *    一次的券种。故发券弹窗里「关联券种」是**可选**的，不选就是一张独立补偿券。
 * 2. **面额 / 有效期建了就不能改**（PUT 只收 status / remark / totalLimit）——
 *    券种发出后，那批券的核销口径就定死在用户手上了；改面额等于事后变更已承诺的
 *    权益。要改就停用旧券种 + 新建（页面顶部已写明）。
 * 3. **发券必填备注**：这是日后唯一能回答「为什么给这个人发钱」的信息，
 *    与 D39 余额调账同纪律。
 *
 * ⚠️ 金额一律整数分，端上只做 `÷100` 展示；输入是元、提交前 `×100` 取整。
 */

const money = (fen?: number | null) => `¥${((fen ?? 0) / 100).toFixed(2)}`;

const loading = ref(false);
const defs = ref<CouponDefRow[]>([]);
const grants = ref<UserCouponRow[]>([]);
const grantFilter = ref('');
const grantUserId = ref<number | undefined>(undefined);

// ---- 新建券种 ----
const defDialog = ref(false);
const defSubmitting = ref(false);
const defForm = ref({
  name: '',
  faceValueYuan: 5,
  thresholdYuan: 0,
  validityType: 'days' as CouponValidityType,
  validDays: 30,
  validFrom: '',
  validTo: '',
  totalLimit: undefined as number | undefined,
  remark: '',
});
const defValidDateRange = ref<[string, string] | null>(null);

// ---- 手动发券 ----
const grantDialog = ref(false);
const grantSubmitting = ref(false);
const grantForm = ref({
  userPhone: '',
  userId: undefined as number | undefined,
  couponDefId: undefined as number | undefined,
  faceValueYuan: 5,
  thresholdYuan: 0,
  validityType: 'days' as CouponValidityType,
  validDays: 30,
  obtainedFrom: 'compensation' as GrantCouponPayload['obtainedFrom'],
  remark: '',
});

const yuanToFen = (yuan: number) => Math.round(Number(yuan || 0) * 100);

/** el-table 的插槽 `row` 是 `DefaultRow`，显式收敛回业务行类型（同 `finance/balance.vue`） */
const asRow = (row: unknown) => row as CouponDefRow;
const asGrantRow = (row: unknown) => row as UserCouponRow;

/**
 * 券状态文案 / 标签色（2026-10-29 起有三种）
 *
 * ⚠️ **必须显式列出 `revoked`**：写成 `status === 'used' ? '已使用' : '未使用'` 的旧判据，
 *    会把回收掉的券显示成「未使用」—— 运营会以为它还在用户手里、还能用。
 */
const statusText = (s: string) => (s === 'used' ? '已使用' : s === 'revoked' ? '已回收' : '未使用');
const statusTagType = (s: string) =>
  s === 'used' ? 'info' : s === 'revoked' ? 'warning' : 'success';

const activeDefOptions = computed(() =>
  defs.value.filter((d) => d.status === 'active').map((d) => ({ value: d.id, label: d.name })),
);

/** 发券用的「来源」选项：去掉值为空的「全部来源」（那是筛选用途，不是发券用途） */
const grantFromOptions = OBTAINED_FROM_OPTIONS.filter((o) => o.value);

/** 批量弹窗里选了券种 → 面额 / 门槛 / 有效期跟随券种（避免手输与券种不一致） */
function onPickBatchDef(id: number | undefined) {
  const d = defs.value.find((x) => x.id === id);
  if (!d) return;
  batchForm.value.faceValueYuan = d.faceValueFen / 100;
  batchForm.value.thresholdYuan = d.thresholdFen / 100;
  batchForm.value.validityType = d.validityType;
  if (d.validityType === 'days') batchForm.value.validDays = d.validDays ?? 30;
  invalidatePreview();
}

/** 选了券种 → 面额/门槛/有效期跟随券种（避免运营手输与券种不一致） */
function onPickDef(id: number | undefined) {
  const d = defs.value.find((x) => x.id === id);
  if (!d) return;
  grantForm.value.faceValueYuan = d.faceValueFen / 100;
  grantForm.value.thresholdYuan = d.thresholdFen / 100;
  grantForm.value.validityType = d.validityType;
  if (d.validityType === 'days') grantForm.value.validDays = d.validDays ?? 30;
}

async function load() {
  loading.value = true;
  try {
    defs.value = await fetchCouponDefs();
    grants.value = await fetchCouponGrants({
      obtainedFrom: grantFilter.value || undefined,
      userId: grantUserId.value || undefined,
    });
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------------------- 券种

function openDefDialog() {
  defForm.value = {
    name: '',
    faceValueYuan: 5,
    thresholdYuan: 0,
    validityType: 'days',
    validDays: 30,
    validFrom: '',
    validTo: '',
    totalLimit: undefined,
    remark: '',
  };
  defValidDateRange.value = null;
  defDialog.value = true;
}

async function submitDef() {
  const faceValueFen = yuanToFen(defForm.value.faceValueYuan);
  if (!defForm.value.name.trim()) return ElMessage.warning('请填写券种名称');
  if (faceValueFen <= 0) return ElMessage.warning('面额必须大于 0');

  const payload = {
    name: defForm.value.name.trim(),
    faceValueFen,
    thresholdFen: yuanToFen(defForm.value.thresholdYuan),
    validityType: defForm.value.validityType,
    validDays: defForm.value.validityType === 'days' ? defForm.value.validDays : null,
    validFrom:
      defForm.value.validityType === 'period' ? (defValidDateRange.value?.[0] ?? null) : null,
    validTo:
      defForm.value.validityType === 'period' ? (defValidDateRange.value?.[1] ?? null) : null,
    totalLimit: defForm.value.totalLimit ?? null,
    remark: defForm.value.remark.trim() || null,
  };
  if (payload.validityType === 'period' && (!payload.validFrom || !payload.validTo)) {
    return ElMessage.warning('固定起止日的券必须选择有效期区间');
  }

  defSubmitting.value = true;
  try {
    await createCouponDef(payload);
    ElMessage.success('券种已创建');
    defDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '创建失败');
  } finally {
    defSubmitting.value = false;
  }
}

async function toggleDef(row: CouponDefRow) {
  const next = row.status === 'active' ? 'inactive' : 'active';
  try {
    await ElMessageBox.confirm(
      `确定将券种「${row.name}」${next === 'inactive' ? '停用' : '启用'}？\n\n` +
        `停用只影响**后续发放**，已发出的券不受影响。`,
      '切换券种状态',
      { confirmButtonText: '确定', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }
  try {
    await updateCouponDef(row.id, { status: next });
    ElMessage.success('已更新');
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '更新失败');
  }
}

// ---------------------------------------------------------------- 发券

function openGrantDialog() {
  grantForm.value = {
    userPhone: '',
    userId: undefined,
    couponDefId: undefined,
    faceValueYuan: 5,
    thresholdYuan: 0,
    validityType: 'days',
    validDays: 30,
    obtainedFrom: 'compensation',
    remark: '',
  };
  grantDialog.value = true;
}

async function submitGrant() {
  const f = grantForm.value;
  if (!f.userId && !f.userPhone.trim()) {
    return ElMessage.warning('请填写用户 ID 或手机号（二选一）');
  }
  if (f.remark.trim().length < 2) {
    return ElMessage.warning(
      '请填写发放原因（至少 2 个字）—— 这是日后唯一能回答「为什么发这笔券」的信息',
    );
  }
  const faceValueFen = yuanToFen(f.faceValueYuan);
  if (faceValueFen <= 0) return ElMessage.warning('面额必须大于 0');

  const who = f.userId ? `用户 #${f.userId}` : `手机号 ${f.userPhone.trim()}`;
  try {
    await ElMessageBox.confirm(
      `将给「${who}」发放一张 ${money(faceValueFen)} 的代金券。\n\n` +
        `· 来源：${OBTAINED_FROM_OPTIONS.find((o) => o.value === f.obtainedFrom)?.label ?? f.obtainedFrom}\n` +
        `· 有效期：领取后 ${f.validDays} 天（自发放起算）\n` +
        `· 原因：${f.remark.trim()}\n\n` +
        `发券不可撤销（券只能由用户自己用掉）。`,
      '确认发放代金券',
      { confirmButtonText: '确认发放', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return;
  }

  grantSubmitting.value = true;
  try {
    const res = await grantCoupon({
      userId: f.userId || undefined,
      userPhone: f.userPhone.trim() || undefined,
      couponDefId: f.couponDefId ?? null,
      faceValueFen,
      thresholdFen: yuanToFen(f.thresholdYuan),
      validityType: f.validityType,
      validDays: f.validityType === 'days' ? f.validDays : null,
      obtainedFrom: f.obtainedFrom,
      remark: f.remark.trim(),
    });
    ElMessage.success(`已发放：券码 ${res.code}`);
    grantDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '发放失败');
  } finally {
    grantSubmitting.value = false;
  }
}

// ---------------------------------------------------------------- 批量发放

/**
 * 批量发放（2026-10-29）
 *
 * ⭐ 铁律：**先试算、后实发**。试算与实发在服务端走**同一条路径**（只差写库一步），
 *    端上**绝不自己数人数** —— 自己数就会出现「试算 73 人、实发 80 人」。
 *    故「确认发放」在没有试算结果时直接拦下（见 `submitBatch` 第一句）。
 */
const batchDialog = ref(false);
const batchSubmitting = ref(false);
const batchPreviewing = ref(false);
const batchPreview = ref<CouponGrantBatchResult | null>(null);
const buildings = ref<Array<{ id: number; name: string }>>([]);
const batchForm = ref({
  scope: 'all' as CouponGrantScope,
  buildingId: undefined as number | undefined,
  phonesText: '',
  userIdsText: '',
  couponDefId: undefined as number | undefined,
  faceValueYuan: 5,
  thresholdYuan: 0,
  validityType: 'days' as CouponValidityType,
  validDays: 30,
  obtainedFrom: 'compensation' as GrantCouponPayload['obtainedFrom'],
  remark: '',
  excludeBlacklist: true,
});

/**
 * 幂等键：弹窗打开时生成一次，「试算 → 实发」共用同一个键。
 *
 * ⚠️ 为什么不是每次提交都生成新的：那样双击「确认发放」会因为批次号不同而**发出两批**。
 *    重开弹窗才算新的一次操作，才换键（允许运营刻意再发一批）。
 */
let batchIdemKey = '';
const newIdemKey = () => `bk-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

async function loadBuildings() {
  if (buildings.value.length) return; // 拉一次就够（楼宇不常变）
  try {
    const opts = await fetchUserFilterOptions();
    buildings.value = opts.buildings.map((b) => ({ id: b.id, name: b.name }));
  } catch {
    /* 下拉拉不到也不影响：可改用「全平台 / 手机号清单」两种人群 */
  }
}

function openBatchDialog() {
  batchForm.value = {
    scope: 'all',
    buildingId: undefined,
    phonesText: '',
    userIdsText: '',
    couponDefId: undefined,
    faceValueYuan: 5,
    thresholdYuan: 0,
    validityType: 'days',
    validDays: 30,
    obtainedFrom: 'compensation',
    remark: '',
    excludeBlacklist: true,
  };
  batchPreview.value = null;
  batchIdemKey = newIdemKey();
  batchDialog.value = true;
  void loadBuildings();
}

/** 人群或人群参数变了 → 旧试算结果必须作废（否则会拿旧人数去确认） */
function invalidatePreview() {
  batchPreview.value = null;
}

/** 粘贴框解析：空格 / 逗号 / 分号 / 换行都算分隔符（运营多从 Excel 整列粘下来） */
function parseList(text: string): string[] {
  return text
    .split(/[\s,，;；\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildBatchPayload(dryRun: boolean): GrantCouponBatchPayload | null {
  const f = batchForm.value;
  if (f.remark.trim().length < 2) {
    ElMessage.warning('请填写发放原因（至少 2 个字）—— 这是日后唯一能回答「为什么发这笔券」的信息');
    return null;
  }
  const faceValueFen = yuanToFen(f.faceValueYuan);
  if (faceValueFen <= 0) {
    ElMessage.warning('面额必须大于 0');
    return null;
  }
  const base = {
    couponDefId: f.couponDefId ?? null,
    faceValueFen,
    thresholdFen: yuanToFen(f.thresholdYuan),
    validityType: f.validityType,
    validDays: f.validityType === 'days' ? f.validDays : null,
    validFrom: null,
    validTo: null,
    obtainedFrom: f.obtainedFrom,
    remark: f.remark.trim(),
    dryRun,
    idempotencyKey: batchIdemKey,
    excludeBlacklist: f.excludeBlacklist,
  };
  if (f.scope === 'building') {
    if (!f.buildingId) {
      ElMessage.warning('请先选择楼宇');
      return null;
    }
    return { ...base, scope: 'building', buildingId: f.buildingId };
  }
  if (f.scope === 'phones') {
    const phones = parseList(f.phonesText);
    if (!phones.length) {
      ElMessage.warning('请粘贴手机号清单（空格 / 逗号 / 换行分隔）');
      return null;
    }
    return { ...base, scope: 'phones', phones };
  }
  if (f.scope === 'userIds') {
    const ids = parseList(f.userIdsText)
      .map((s) => Number(s))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (!ids.length) {
      ElMessage.warning('请填写用户 ID（正整数；多个用空格 / 逗号分隔）');
      return null;
    }
    return { ...base, scope: 'userIds', userIds: ids };
  }
  return { ...base, scope: 'all' };
}

async function runBatchPreview() {
  const payload = buildBatchPayload(true);
  if (!payload) return;
  batchPreviewing.value = true;
  try {
    batchPreview.value = await grantCouponBatch(payload);
  } catch (e) {
    ElMessage.error((e as Error).message || '试算失败');
  } finally {
    batchPreviewing.value = false;
  }
}

async function submitBatch() {
  const pv = batchPreview.value;
  if (!pv) {
    return ElMessage.warning('请先点「试算」—— 批量发券必须先看清楚发给多少人');
  }
  if (pv.grantedCount === 0) {
    return ElMessage.warning('本次命中 0 人，没有可发放的对象');
  }
  const payload = buildBatchPayload(false);
  if (!payload) return;

  const f = batchForm.value;
  const scopeLabel = GRANT_SCOPE_OPTIONS.find((o) => o.value === f.scope)?.label ?? f.scope;
  const perFen = pv.grantedCount > 0 ? Math.round(pv.totalFaceValueFen / pv.grantedCount) : 0;
  try {
    await ElMessageBox.confirm(
      `将给「${scopeLabel}」共 ${pv.grantedCount} 人各发放一张 ${money(perFen)} 的代金券。\n\n` +
        `· 面额合计：${money(pv.totalFaceValueFen)}\n` +
        `· 有效期：${f.validityType === 'days' ? `领取后 ${f.validDays} 天（自发放起算）` : '固定起止日'}\n` +
        `· 原因：${f.remark.trim()}\n` +
        `· 批次号：${pv.batchNo}\n\n` +
        `发放后可在下方「发放记录」里逐张回收（仅限尚未使用的券）。`,
      '确认批量发放',
      {
        confirmButtonText: `确认发给 ${pv.grantedCount} 人`,
        cancelButtonText: '取消',
        type: 'warning',
      },
    );
  } catch {
    return;
  }

  batchSubmitting.value = true;
  try {
    const res = await grantCouponBatch(payload);
    ElMessage.success(`已发放 ${res.grantedCount} 张（批次 ${res.batchNo}）`);
    batchDialog.value = false;
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '发放失败');
  } finally {
    batchSubmitting.value = false;
  }
}

// ---------------------------------------------------------------- 回收

/**
 * 回收一张券（批量发券的兜底）
 *
 * ⚠️ 只有**未使用**的券能撤（服务端判据 `canRevoke`）：已核销的券已被订单用作抵扣，
 *    撤掉等于让那笔订单白拿优惠。故本入口只对 `unused` 显示。
 */
async function revokeGrant(row: UserCouponRow) {
  let reason = '';
  try {
    const res = await ElMessageBox.prompt(
      `券码 ${row.code}（${money(row.faceValueFen)}）将被作废，用户端显示为「已回收」。\n\n` +
        `已核销的券不能回收（订单已享受抵扣），本按钮也只在未使用时出现。`,
      '回收代金券',
      {
        confirmButtonText: '确认回收',
        cancelButtonText: '取消',
        type: 'warning',
        inputType: 'textarea',
        inputPlaceholder: '填写回收原因（必填，进操作日志）',
        inputValidator: (v: string) =>
          (v ?? '').trim().length >= 2 || '回收原因至少 2 个字（日后要靠它回答为什么撤）',
      },
    );
    reason = String(res.value ?? '').trim();
  } catch {
    return;
  }
  try {
    await revokeCoupon(row.id, reason);
    ElMessage.success('已回收');
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '回收失败');
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page-container">
    <h2 class="page-container__title">代金券管理</h2>
    <p class="page-container__meta">
      真源 = <code>ab_coupon</code>（券种定义）+ <code>ab_user_coupon</code>（用户持有）·
      下单时自动选用抵扣最多的一张，落到订单 <code>discount_amount</code> ·
      券种<strong>面额与有效期一经发放不可改</strong>（要改就停用旧券种 + 新建）
    </p>

    <!-- 券种定义 -->
    <el-card v-loading="loading" shadow="never" class="blk">
      <template #header>
        <div class="hd">
          <span>券种定义（{{ defs.length }}）</span>
          <div>
            <el-button size="small" @click="load">刷新</el-button>
            <el-button type="primary" size="small" @click="openDefDialog">新建券种</el-button>
          </div>
        </div>
      </template>

      <el-table v-if="defs.length" :data="defs" size="small" stripe>
        <el-table-column prop="id" label="ID" width="70" />
        <el-table-column prop="name" label="券种名称" min-width="150" />
        <el-table-column label="面额" width="100" align="right">
          <template #default="{ row }">
            <strong>{{ money(row.faceValueFen) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="门槛" width="100" align="right">
          <template #default="{ row }">
            {{ row.thresholdFen > 0 ? `满 ${money(row.thresholdFen)}` : '无门槛' }}
          </template>
        </el-table-column>
        <el-table-column label="有效期" min-width="150">
          <template #default="{ row }">
            {{
              row.validityType === 'days'
                ? `领取后 ${row.validDays} 天`
                : `${row.validFrom || '—'} 至 ${row.validTo || '—'}`
            }}
          </template>
        </el-table-column>
        <el-table-column label="发放" width="110" align="right">
          <template #default="{ row }">
            {{ row.issuedCount }}{{ row.totalLimit ? ` / ${row.totalLimit}` : '' }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="row.status === 'active' ? 'success' : 'info'" size="small">
              {{ COUPON_STATUS_OPTIONS.find((o) => o.value === row.status)?.label ?? row.status }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="remark" label="备注" min-width="160" />
        <el-table-column label="操作" width="90" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="toggleDef(asRow(row))">
              {{ row.status === 'active' ? '停用' : '启用' }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="还没有券种。客服补偿可直接「发放代金券」，不必先建券种" />
    </el-card>

    <!-- 发放记录 -->
    <el-card v-loading="loading" shadow="never" class="blk">
      <template #header>
        <div class="hd">
          <span>发放记录（最近 200 条）</span>
          <div class="filters">
            <el-select
              v-model="grantFilter"
              size="small"
              class="sel"
              placeholder="全部来源"
              @change="load"
            >
              <el-option
                v-for="o in OBTAINED_FROM_OPTIONS"
                :key="o.value"
                :label="o.label"
                :value="o.value"
              />
            </el-select>
            <el-input-number
              v-model="grantUserId"
              size="small"
              class="uid"
              :min="1"
              :controls="false"
              placeholder="用户 ID"
              @change="load"
            />
            <el-button type="primary" size="small" @click="openGrantDialog">发放代金券</el-button>
            <el-button type="danger" size="small" plain @click="openBatchDialog"
              >批量发放</el-button
            >
          </div>
        </div>
      </template>

      <el-table v-if="grants.length" :data="grants" size="small" stripe>
        <el-table-column prop="code" label="券码" min-width="150" />
        <el-table-column prop="name" label="名称" min-width="120" />
        <el-table-column label="面额" width="90" align="right">
          <template #default="{ row }">{{ money(row.faceValueFen) }}</template>
        </el-table-column>
        <el-table-column label="有效期" min-width="190">
          <template #default="{ row }">
            {{ (row.validFrom || '').slice(0, 10) }} 至 {{ (row.validTo || '').slice(0, 10) }}
          </template>
        </el-table-column>
        <el-table-column label="来源" width="100">
          <template #default="{ row }">
            {{
              OBTAINED_FROM_OPTIONS.find((o) => o.value === row.obtainedFrom)?.label ??
              row.obtainedFrom
            }}
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag :type="statusTagType(row.status)" size="small">
              {{ statusText(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="orderNo" label="核销订单" min-width="150" />
        <el-table-column label="操作" width="80" fixed="right">
          <template #default="{ row }">
            <el-button
              v-if="row.status === 'unused'"
              link
              type="danger"
              @click="revokeGrant(asGrantRow(row))"
            >
              回收
            </el-button>
          </template>
        </el-table-column>
        <el-table-column label="发放时间" min-width="160">
          <template #default="{ row }">
            {{ row.createdAt ? row.createdAt.replace('T', ' ').slice(0, 19) : '—' }}
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="还没有发放记录" />
    </el-card>

    <!-- 新建券种 -->
    <el-dialog v-model="defDialog" title="新建券种" width="560px">
      <el-form label-width="96px">
        <el-form-item label="券种名称">
          <el-input v-model="defForm.name" maxlength="32" placeholder="例：客服补偿券 5 元" />
        </el-form-item>
        <el-form-item label="面额">
          <el-input-number v-model="defForm.faceValueYuan" :min="0" :precision="2" :step="1" />
          <span class="sub ml">元 ＝ {{ yuanToFen(defForm.faceValueYuan) }} 分</span>
        </el-form-item>
        <el-form-item label="使用门槛">
          <el-input-number v-model="defForm.thresholdYuan" :min="0" :precision="2" :step="1" />
          <span class="sub ml">元（0 = 无门槛）</span>
        </el-form-item>
        <el-form-item label="有效期类型">
          <el-radio-group v-model="defForm.validityType">
            <el-radio-button label="days">领取后 N 天</el-radio-button>
            <el-radio-button label="period">固定起止日</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="defForm.validityType === 'days'" label="有效天数">
          <el-input-number v-model="defForm.validDays" :min="1" :max="365" />
        </el-form-item>
        <el-form-item v-else label="起止日期">
          <el-date-picker
            v-model="defValidDateRange"
            type="daterange"
            value-format="YYYY-MM-DD"
            range-separator="至"
            start-placeholder="生效日"
            end-placeholder="失效日"
          />
        </el-form-item>
        <el-form-item label="发行上限">
          <el-input-number
            v-model="defForm.totalLimit"
            :min="1"
            :controls="false"
            placeholder="留空 = 不限"
          />
          <span class="sub ml">张（留空 = 不限量）</span>
        </el-form-item>
        <el-form-item label="备注">
          <el-input v-model="defForm.remark" type="textarea" :rows="2" maxlength="128" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="defDialog = false">取消</el-button>
        <el-button type="primary" :loading="defSubmitting" @click="submitDef">创建</el-button>
      </template>
    </el-dialog>

    <!-- 手动发券 -->
    <el-dialog v-model="grantDialog" title="发放代金券" width="560px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="发券后可回收（仅限未使用）"
        description="券发出后由用户自己用掉或过期。若发错，可在下方「发放记录」里逐张回收 —— 但已经核销（已使用）的券不能撤，因为订单已经享受了抵扣。请确认金额与对象无误。"
        class="alert"
      />
      <el-form label-width="96px">
        <el-form-item label="接收用户">
          <el-input v-model="grantForm.userPhone" class="grow" placeholder="手机号（推荐）" />
          <span class="sub ml">或</span>
          <el-input-number
            v-model="grantForm.userId"
            class="uid"
            :min="1"
            :controls="false"
            placeholder="用户 ID"
          />
        </el-form-item>
        <el-form-item label="关联券种">
          <el-select
            v-model="grantForm.couponDefId"
            clearable
            class="grow"
            placeholder="（可选）不选 = 一次性补偿券"
            @change="onPickDef"
          >
            <el-option
              v-for="o in activeDefOptions"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="面额">
          <el-input-number v-model="grantForm.faceValueYuan" :min="0" :precision="2" :step="1" />
          <span class="sub ml">元 ＝ {{ yuanToFen(grantForm.faceValueYuan) }} 分</span>
        </el-form-item>
        <el-form-item label="使用门槛">
          <el-input-number v-model="grantForm.thresholdYuan" :min="0" :precision="2" :step="1" />
          <span class="sub ml">元（0 = 无门槛）</span>
        </el-form-item>
        <el-form-item label="有效期">
          <el-input-number v-model="grantForm.validDays" :min="1" :max="365" />
          <span class="sub ml">天（自发放起算）</span>
        </el-form-item>
        <el-form-item label="来源">
          <el-select v-model="grantForm.obtainedFrom">
            <el-option
              v-for="o in OBTAINED_FROM_OPTIONS.filter((x) => x.value)"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="发放原因">
          <el-input
            v-model="grantForm.remark"
            type="textarea"
            :rows="2"
            maxlength="128"
            placeholder="必填 · 例：10-22 配送超时补偿"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="grantDialog = false">取消</el-button>
        <el-button type="primary" :loading="grantSubmitting" @click="submitGrant">
          确认发放
        </el-button>
      </template>
    </el-dialog>

    <!-- 批量发放（先试算后实发） -->
    <el-dialog v-model="batchDialog" title="批量发放代金券" width="640px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="先试算，再发放"
        description="批量发券一次影响几十人、且发出即承诺。请先点「试算」核对人数与金额，再发放。发放后可对尚未使用的券逐张回收。"
        class="alert"
      />
      <el-form label-width="100px">
        <el-form-item label="发放人群">
          <el-radio-group v-model="batchForm.scope" @change="invalidatePreview">
            <el-radio-button
              v-for="o in GRANT_SCOPE_OPTIONS"
              :key="o.value"
              :label="o.value"
              :value="o.value"
            >
              {{ o.label }}
            </el-radio-button>
          </el-radio-group>
        </el-form-item>

        <el-form-item v-if="batchForm.scope === 'building'" label="选择楼宇">
          <el-select
            v-model="batchForm.buildingId"
            placeholder="请选择楼宇"
            class="grow"
            @change="invalidatePreview"
          >
            <el-option v-for="b in buildings" :key="b.id" :label="b.name" :value="b.id" />
          </el-select>
        </el-form-item>

        <el-form-item v-if="batchForm.scope === 'phones'" label="手机号清单">
          <el-input
            v-model="batchForm.phonesText"
            type="textarea"
            :rows="3"
            placeholder="一行一个，或空格 / 逗号分隔（最多 500 个）"
            @input="invalidatePreview"
          />
        </el-form-item>

        <el-form-item v-if="batchForm.scope === 'userIds'" label="用户 ID">
          <el-input
            v-model="batchForm.userIdsText"
            type="textarea"
            :rows="2"
            placeholder="例：1, 2, 3（最多 500 个）"
            @input="invalidatePreview"
          />
        </el-form-item>

        <el-form-item label="关联券种">
          <el-select
            v-model="batchForm.couponDefId"
            clearable
            placeholder="不选 = 独立补偿券"
            class="grow"
            @change="onPickBatchDef"
          >
            <el-option
              v-for="d in activeDefOptions"
              :key="d.value"
              :label="d.label"
              :value="d.value"
            />
          </el-select>
        </el-form-item>

        <el-form-item label="面额">
          <el-input-number v-model="batchForm.faceValueYuan" :min="0" :precision="2" :step="1" />
          <span class="sub ml">元 ＝ {{ yuanToFen(batchForm.faceValueYuan) }} 分</span>
        </el-form-item>
        <el-form-item label="使用门槛">
          <el-input-number v-model="batchForm.thresholdYuan" :min="0" :precision="2" :step="1" />
          <span class="sub ml">元（0 = 无门槛）</span>
        </el-form-item>
        <el-form-item label="有效期类型">
          <el-radio-group v-model="batchForm.validityType">
            <el-radio-button label="days" value="days">领取后 N 天</el-radio-button>
            <el-radio-button label="period" value="period">固定起止日</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item v-if="batchForm.validityType === 'days'" label="有效天数">
          <el-input-number v-model="batchForm.validDays" :min="1" :max="365" />
          <span class="sub ml">天（自发放起算）</span>
        </el-form-item>
        <el-form-item label="来源">
          <el-select v-model="batchForm.obtainedFrom">
            <el-option
              v-for="o in grantFromOptions"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="发放原因">
          <el-input
            v-model="batchForm.remark"
            type="textarea"
            :rows="2"
            maxlength="256"
            placeholder="必填（至少 2 个字）；会写进这一批每一张券的备注"
          />
        </el-form-item>
        <el-form-item label="排除黑名单">
          <el-switch v-model="batchForm.excludeBlacklist" @change="invalidatePreview" />
          <span class="sub ml">关闭后黑名单用户也会收到（一般不必关）</span>
        </el-form-item>
      </el-form>

      <!-- 试算结果：没试算过就不给发放（按钮 disabled） -->
      <div class="preview">
        <el-button size="small" :loading="batchPreviewing" @click="runBatchPreview">
          试算（不发放）
        </el-button>
        <div v-if="batchPreview" class="preview__box">
          <p class="preview__head">
            将发放 <strong>{{ batchPreview.grantedCount }}</strong> 张 · 面额合计
            <strong>{{ money(batchPreview.totalFaceValueFen) }}</strong>
          </p>
          <ul class="preview__list">
            <li>
              批次号：<code>{{ batchPreview.batchNo }}</code>
            </li>
            <li v-if="batchPreview.skippedCount">
              同一批已发过而跳过：{{ batchPreview.skippedCount }} 人
            </li>
            <li v-if="batchPreview.excludedCount">
              黑名单排除：{{ batchPreview.excludedCount }} 人
            </li>
            <li v-if="batchPreview.unmatchedPhones.length">
              查无此人的号码（{{ batchPreview.unmatchedPhones.length }} 个）：{{
                batchPreview.unmatchedPhones.join('、')
              }}
            </li>
            <li v-if="batchPreview.samplePhones.length">
              命中样例：{{ batchPreview.samplePhones.join('、') }}
            </li>
          </ul>
        </div>
        <p v-else class="sub">未试算 —— 确认发放前必须先试算一次</p>
      </div>

      <template #footer>
        <el-button @click="batchDialog = false">取消</el-button>
        <el-button
          type="danger"
          :loading="batchSubmitting"
          :disabled="!batchPreview"
          @click="submitBatch"
        >
          确认发放
        </el-button>
      </template>
    </el-dialog>

    <p class="note">
      口径提示：券<strong>不找零、不折现</strong>，一单只能用一张；下单时<strong>自动选用抵扣最多的那张</strong>（端上不做选券）。取消订单与退款审批通过时，券<strong>自动退回</strong>为未使用
      ——
      退券是幂等的，重复触发不会多发。批量发放<strong>先试算后实发</strong>；发出去的券可在发放记录里<strong>逐张回收</strong>（仅限尚未使用的）。
    </p>
  </div>
</template>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-4;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.blk {
  margin-bottom: $space-3;
}

.hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: $space-2;
}

.filters {
  display: flex;
  align-items: center;
  gap: $space-2;
}

.sel {
  width: 140px;
}

.uid {
  width: 130px;
}

.grow {
  flex: 1;
}

.alert {
  margin-bottom: $space-3;
}

.sub {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.ml {
  margin-left: 8px;
}

.preview {
  margin-top: $space-3;
  padding-top: $space-3;
  border-top: 1px solid $c-border;
}

.preview__box {
  margin-top: $space-2;
  padding: $space-2 $space-3;
  background: $c-surface-3;
  border-radius: 4px;
}

.preview__head {
  margin: 0 0 $space-2;
  font-size: $fs-body;
}

.preview__list {
  margin: 0;
  padding-left: 18px;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.9;
}

.note {
  margin: 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.8;
}
</style>
