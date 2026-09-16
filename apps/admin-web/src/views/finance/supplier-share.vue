<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  fetchShareExceptions,
  fetchSupplierShares,
  generateSupplierShares,
  registerSharePayment,
  type ShareExceptionItem,
  type SharesSummary,
  type SupplierShareRow,
} from '@/api/supplier-share';

/**
 * P34 应付结算（S9 · M3-9 · 《ABox一盒自营结算口径定义v1.0.md》）
 *
 * ## 三个口径决定了页面长什么样
 * 1. **按出餐日聚合**：出单对象是「某个出餐日的交付量」，默认查**昨天** ——
 *    跑批在 T+1 02:00，昨天才是刚出单的那天；按「今天」查通常空空如也。
 * 2. **「生成应付」必须连带回答「为什么没出」**：接口同时返回 `created / skipped /
 *    exceptions`，页面把 `exceptions` 摊开 —— 运营点完按钮最想知道的就是这个。
 * 3. **付款登记是资金动作**：按钮可用性由服务端 `canRegisterPayment` 决定
 *    （`operator` 只读、`viewer` 进不来），回单号**必填** —— 它是「钱确实付了」的唯一凭证。
 *
 * ⚠️ 不做「按供应商下拉筛选」：应付结算是按日走款的流程，运营按日期扫一遍即可，
 *    每行都带供应商名；关键词框已能按**单号 / 回单号 / 发票号**定位（对账的常用入口）。
 */
const loading = ref(false);
const generating = ref(false);
const date = ref('');
const status = ref('all');
const keyword = ref('');
const rows = ref<SupplierShareRow[]>([]);
const summary = ref<SharesSummary | null>(null);
const statusOptions = ref<Array<{ value: string; label: string }>>([]);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);
const exceptions = ref<ShareExceptionItem[]>([]);

const payVisible = ref(false);
const paying = ref(false);
const payTarget = ref<SupplierShareRow | null>(null);
const payForm = ref({ paymentVoucherNo: '', invoiceNo: '' });

const money = (fen?: number) => `¥${((fen ?? 0) / 100).toFixed(2)}`;

const REASON_LABEL: Record<string, string> = {
  not_started: '未开始确认',
  incomplete: '确认未完成',
  actual_missing: '实收量缺失',
  license_invalid: '资质异常',
  zero_quantity: '实收 0',
};
const reasonLabel = (r: string) => REASON_LABEL[r] ?? r;

const statusType = (s: string) =>
  s === 'success' ? 'success' : s === 'reversed' ? 'info' : s === 'failed' ? 'danger' : 'warning';

const hasExceptions = computed(() => exceptions.value.length > 0);

/** 北京时间「昨天」（= 跑批刚出单的那天） */
function defaultDate(): string {
  const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const [y, m, d] = today.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) - 86400000).toISOString().slice(0, 10);
}

async function load() {
  loading.value = true;
  try {
    const res = await fetchSupplierShares({
      date: date.value || undefined,
      status: status.value,
      keyword: keyword.value.trim() || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = res.list ?? [];
    summary.value = res.summary ?? null;
    statusOptions.value = res.statusOptions ?? [];
    total.value = res.total ?? 0;
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function loadExceptions() {
  if (!date.value) {
    exceptions.value = [];
    return;
  }
  try {
    const res = await fetchShareExceptions(date.value);
    exceptions.value = res.list ?? [];
  } catch {
    // 异常清单是辅助信息，取不到不该把主列表也变成报错态
    exceptions.value = [];
  }
}

async function reload() {
  page.value = 1;
  await Promise.all([load(), loadExceptions()]);
}

async function onGenerate() {
  if (!date.value) {
    ElMessage.warning('请先选择出餐日');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `将为「${date.value}」的出餐计划生成应付结算单。\n\n` +
        '口径：按**实收量 × 逐菜协商价**（出餐计划生成时冻结的快照），对象只有供应商；' +
        '同一（供应商 · 菜品 · 出餐日）已有单则自动跳过 —— 可安全重复执行。',
      '生成应付单',
      { confirmButtonText: '确认生成', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return; // 用户取消
  }

  generating.value = true;
  try {
    const res = await generateSupplierShares({ date: date.value });
    const s = res.summary;
    const lines = [
      `新增 ${s.createdCount} 单 · 应付 ${money(s.createdAmountFen)}`,
      `跳过 ${s.skippedCount}（已出过单）`,
      `未出单 ${s.exceptionCount}${s.exceptionCount ? '（见下方异常清单，需人工处理）' : ''}`,
    ].join('\n');

    if (s.createdCount === 0 && s.exceptionCount > 0) {
      await ElMessageBox.alert(
        `${lines}\n\n${'注意：这批没出单是因为系统缺关键输入时不猜默认值 —— 按已确认量出会少付、按计划量补齐会多付。补齐后再点一次「生成应付」即可补出。'}`,
        '生成完成（有未出单项）',
        { confirmButtonText: '知道了' },
      );
    } else {
      ElMessage.success(lines.replace(/\n/g, ' · '));
    }
    await reload();
  } catch (e) {
    ElMessage.error((e as Error).message || '生成失败');
  } finally {
    generating.value = false;
  }
}

/** el-table 插槽的 row 是宽松 DefaultRow，入口断言一次，避免 `as` 扩散到模板 */
function asRow(raw: unknown): SupplierShareRow {
  return raw as SupplierShareRow;
}

function openPay(row: SupplierShareRow) {
  if (!row.canRegisterPayment) {
    ElMessage.warning(row.blockReason || '当前状态不能登记付款');
    return;
  }
  payTarget.value = row;
  payForm.value = { paymentVoucherNo: '', invoiceNo: '' };
  payVisible.value = true;
}

async function submitPay() {
  const target = payTarget.value;
  if (!target) return;
  if (!payForm.value.paymentVoucherNo.trim()) {
    ElMessage.warning('请填写银行回单号');
    return;
  }
  paying.value = true;
  try {
    const res = await registerSharePayment(target.id, {
      paymentVoucherNo: payForm.value.paymentVoucherNo.trim(),
      invoiceNo: payForm.value.invoiceNo.trim() || undefined,
    });
    payVisible.value = false;
    ElMessage.success(`已登记付款：${target.shareNo} · ${money(target.amountFen)}`);
    if (res?.tips) {
      await ElMessageBox.alert(res.tips, '付款已登记', { confirmButtonText: '知道了' });
    }
    await reload();
  } catch (e) {
    ElMessage.error((e as Error).message || '登记失败');
  } finally {
    paying.value = false;
  }
}

onMounted(() => {
  date.value = defaultDate();
  void reload();
});
</script>

<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">应付结算（供应商采购款 · 人工对公转账）</h2>
    <p class="page-container__meta">
      原型页 / 模块：P34 · M35 · S9 ｜ 计费基数 = <strong>实收量</strong>（出餐确认申报的实送份数）·
      单价 = 逐菜协商价（出餐计划生成时冻结）· 对象只有供应商
    </p>

    <el-card shadow="never" class="bar">
      <div class="toolbar">
        <el-date-picker
          v-model="date"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="出餐日（默认昨天）"
          :clearable="false"
          @change="reload"
        />
        <el-radio-group v-model="status" @change="reload">
          <el-radio-button label="all">全部</el-radio-button>
          <el-radio-button v-for="opt in statusOptions" :key="opt.value" :label="opt.value">
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
        <el-input
          v-model="keyword"
          class="kw"
          clearable
          placeholder="单号 / 银行回单号 / 发票号"
          @keyup.enter="reload"
          @clear="reload"
        />
        <div class="toolbar__right">
          <el-button @click="reload">刷新</el-button>
          <el-button type="primary" :loading="generating" @click="onGenerate">
            生成应付单
          </el-button>
        </div>
      </div>
    </el-card>

    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">应付合计</span>
        <span class="stats__value">{{ money(summary?.amountFen) }}</span>
        <span class="stats__hint"
          >{{ summary?.rowCount ?? 0 }} 单 · {{ summary?.supplierCount ?? 0 }} 家供应商</span
        >
      </div>
      <div class="stats__item">
        <span class="stats__label">待付款</span>
        <span class="stats__value warn">{{ money(summary?.pendingAmountFen) }}</span>
        <span class="stats__hint">{{ summary?.pendingCount ?? 0 }} 单</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已付款</span>
        <span class="stats__value ok">{{ money(summary?.paidAmountFen) }}</span>
        <span class="stats__hint">{{ summary?.paidCount ?? 0 }} 单</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已冲减（纠错）</span>
        <span class="stats__value">{{ money(summary?.reversedAmountFen) }}</span>
        <span class="stats__hint">{{ summary?.reversedCount ?? 0 }} 单</span>
      </div>
    </div>

    <el-alert
      v-if="hasExceptions"
      class="exc"
      type="warning"
      :closable="false"
      show-icon
      :title="`本日有 ${exceptions.length} 项未出单（系统缺关键输入时不猜默认值，需人工处理）`"
    >
      <el-table :data="exceptions" size="small" class="exc__table">
        <el-table-column prop="supplierName" label="供应商" min-width="120" />
        <el-table-column prop="dishName" label="菜品" min-width="110" />
        <el-table-column prop="planQuantity" label="计划量" width="80" align="right" />
        <el-table-column label="原因" width="110">
          <template #default="{ row }">
            <el-tag size="small" type="warning">{{ reasonLabel(row.reason) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="reasonText" label="说明" min-width="320" />
      </el-table>
    </el-alert>

    <el-card shadow="never">
      <el-table v-if="rows.length" :data="rows" size="small" stripe>
        <el-table-column prop="shareNo" label="应付单号" min-width="150" />
        <el-table-column prop="mealDate" label="出餐日" width="110" />
        <el-table-column prop="supplierName" label="供应商" min-width="110" />
        <el-table-column prop="dishName" label="菜品" min-width="110" />
        <el-table-column label="实收量" width="90" align="right">
          <template #default="{ row }">{{ row.quantity }}</template>
        </el-table-column>
        <el-table-column label="单价" width="100" align="right">
          <template #default="{ row }">{{ money(row.unitPriceFen) }}</template>
        </el-table-column>
        <el-table-column label="应付金额" width="110" align="right">
          <template #default="{ row }"
            ><strong>{{ money(row.amountFen) }}</strong></template
          >
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="statusType(row.status)">{{ row.statusLabel }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="银行回单号" min-width="140">
          <template #default="{ row }">{{ row.paymentVoucherNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="发票号" min-width="110">
          <template #default="{ row }">{{ row.invoiceNo || '—' }}</template>
        </el-table-column>
        <el-table-column label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              :disabled="!row.canRegisterPayment"
              :title="row.blockReason || ''"
              @click="openPay(asRow(row))"
            >
              登记付款
            </el-button>
          </template>
        </el-table-column>
        <template #empty>
          <el-empty
            description="该出餐日暂无应付单 —— 出单在次日凌晨跑批，或当日出餐确认未完成（见上方异常清单）"
          />
        </template>
      </el-table>

      <el-empty
        v-else
        description="该出餐日暂无应付单 —— 出单在次日凌晨跑批；若当日出餐确认未完成，请先看「生成应付单」返回的异常清单"
      />

      <el-pagination
        v-if="total > pageSize"
        class="pager"
        layout="total, prev, pager, next"
        :total="total"
        :current-page="page"
        :page-size="pageSize"
        @current-change="
          (p: number) => {
            page = p;
            load();
          }
        "
      />
    </el-card>

    <el-dialog v-model="payVisible" title="登记付款（人工对公转账 · C10）" width="520px">
      <el-alert
        type="info"
        :closable="false"
        show-icon
        title="系统只记账，不发起任何通道付款"
        description="实际转账由财务走对公账户完成；回单号是「这笔钱确实付了」的唯一凭证，必填。"
      />
      <el-descriptions v-if="payTarget" :column="1" border class="pay-desc">
        <el-descriptions-item label="应付单号">{{ payTarget.shareNo }}</el-descriptions-item>
        <el-descriptions-item label="供应商">{{ payTarget.supplierName }}</el-descriptions-item>
        <el-descriptions-item label="采购内容">
          {{ payTarget.dishName }} · 实收 {{ payTarget.quantity }} 份 ×
          {{ money(payTarget.unitPriceFen) }}
        </el-descriptions-item>
        <el-descriptions-item label="应付金额">
          <strong>{{ money(payTarget.amountFen) }}</strong>
        </el-descriptions-item>
      </el-descriptions>
      <el-form label-width="96px" class="pay-form">
        <el-form-item label="银行回单号" required>
          <el-input v-model="payForm.paymentVoucherNo" placeholder="银行回单号（必填）" />
        </el-form-item>
        <el-form-item label="发票号">
          <el-input
            v-model="payForm.invoiceNo"
            placeholder="供应商发票号（建议登记，税前扣除凭证）"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="payVisible = false">取消</el-button>
        <el-button type="primary" :loading="paying" @click="submitPay">确认登记</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.bar {
  margin-bottom: $space-3;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;

  .kw {
    width: 220px;
  }

  &__right {
    display: flex;
    gap: $space-2;
    margin-left: auto;
  }
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: $space-4;
  padding: $space-2 $space-3;
  margin-bottom: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__item {
    display: flex;
    flex-direction: column;
  }

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    font-size: 20px;
    font-weight: 700;

    &.ok {
      color: var(--el-color-success);
    }

    &.warn {
      color: var(--el-color-warning);
    }
  }

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.exc {
  margin-bottom: $space-3;

  &__table {
    margin-top: $space-2;
  }
}

.pager {
  margin-top: $space-3;
  justify-content: flex-end;
}

.pay-desc {
  margin: $space-3 0;
}

.pay-form {
  margin-top: $space-2;
}
</style>
