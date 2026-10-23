<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  createCouponDef,
  fetchCouponDefs,
  fetchCouponGrants,
  grantCoupon,
  updateCouponDef,
  COUPON_STATUS_OPTIONS,
  OBTAINED_FROM_OPTIONS,
  type CouponDefRow,
  type CouponValidityType,
  type GrantCouponPayload,
  type UserCouponRow,
} from '@/api/coupon';

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

const activeDefOptions = computed(() =>
  defs.value.filter((d) => d.status === 'active').map((d) => ({ value: d.id, label: d.name })),
);

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
            <el-tag :type="row.status === 'used' ? 'info' : 'success'" size="small">
              {{ row.status === 'used' ? '已使用' : '未使用' }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="orderNo" label="核销订单" min-width="150" />
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
        title="发券不可撤销"
        description="券发出后只能由用户自己用掉或过期，后台没有回收入口。请确认金额与对象无误。"
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

    <p class="note">
      口径提示：券<strong>不找零、不折现</strong>，一单只能用一张；下单时<strong>自动选用抵扣最多的那张</strong>（端上不做选券）。取消订单与退款审批通过时，券<strong>自动退回</strong>为未使用
      —— 退券是幂等的，重复触发不会多发。
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

.note {
  margin: 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.8;
}
</style>
