<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchReconciliation, type ReconDiffType, type ReconciliationView } from '@/api/finance';

/**
 * P34 微信支付对账（D43 · M3-15 · 模块 M35-06）
 *
 * ## 页面为什么长这样（三条口径决定）
 * 1. **主体是「差异清单」，不是流水列表**：这一天所有进出账去 D33 / D40 看；
 *    本页只回答「**哪几笔对不上**」，且每条自带服务端下发的 `nextAction`
 *    （「对账不平」四个字无法执行，「去商户平台按订单号查该笔是否真实收款」可以）。
 * 2. **`date` 是支付日，不是出餐日**：对账对象是微信账单，微信按**支付日**切日。
 *    页面把它显式标出来（`anchorLabel`），否则运营会拿它去对 D33/D34/D36 的
 *    出餐日数字，然后得出「对账对不上」的结论 —— 其实是两个时间轴。
 * 3. **⚠️ 必须把「没跟微信对过账」说清楚**：一期无商户号 → 拿不到微信账单，
 *    本页只对了**本地三头**。若渲染成「已与微信对账通过」，运营就会停止怀疑，
 *    而真正的差异（微信收了钱、系统不知道）恰恰只能靠账单比对发现。
 *    故 `channel.note` 常驻页面，不折叠、不省略。
 *
 * ⭐ **不提供「一键平账」**：对账的作用是暴露差异，不是把差异抹掉。
 */
const loading = ref(false);
const date = ref('');
const page = ref(1);
const pageSize = ref(20);
const data = ref<ReconciliationView | null>(null);

const money = (fen?: number | null) => `¥${((fen ?? 0) / 100).toFixed(2)}`;
const signedMoney = (fen?: number | null) => {
  const v = fen ?? 0;
  return v < 0 ? `-¥${(-v / 100).toFixed(2)}` : `¥${(v / 100).toFixed(2)}`;
};

/**
 * 差异类型 → 标签色
 *
 * `order_paid_no_log`（订单说付了、账上没有）与 `duplicate_transaction`
 * （同号多次 = 重复入账前兆）标 `danger`：这两类**可能是真的丢了钱**，
 * 其余两类是数据/凭证问题居多，`warning` / `info` 即可。
 */
const DIFF_TAG: Record<ReconDiffType, 'danger' | 'warning' | 'info'> = {
  order_paid_no_log: 'danger',
  log_success_no_order: 'warning',
  amount_mismatch: 'warning',
  duplicate_transaction: 'danger',
  no_transaction_id: 'info',
};

async function load() {
  loading.value = true;
  try {
    data.value = await fetchReconciliation({
      date: date.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

function onPage(p: number) {
  page.value = p;
  void load();
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page-container">
    <h2 class="page-container__title">财务结算 · 微信对账</h2>
    <p class="page-container__meta">
      原型页 / 模块：P34 · M35-06 ｜ 按<strong>支付日</strong>核对 订单 ↔ 支付流水 ↔ 退款 三头 ·
      出参主体是<strong>差异清单</strong>
    </p>

    <!-- ⚠️ 渠道诚实标注：不折叠、不省略 —— 见脚本头注第 3 条 -->
    <el-alert
      v-if="data?.channel"
      class="channel"
      :type="data.channel.billAvailable ? 'success' : 'warning'"
      :closable="false"
      show-icon
      :title="`对账口径：${data.channel.label}`"
    >
      <span class="channel__text">{{ data.channel.note }}</span>
    </el-alert>

    <el-card shadow="never" class="bar">
      <div class="toolbar">
        <el-date-picker
          v-model="date"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="支付日（默认今日）"
          @change="onPage(1)"
        />
        <span class="toolbar__hint">
          口径锚：{{ data?.anchorLabel ?? '支付日' }} · 当前
          <strong>{{ data?.date ?? '—' }}</strong>
        </span>
        <div class="toolbar__right">
          <el-button @click="load">刷新</el-button>
        </div>
      </div>
    </el-card>

    <div v-loading="loading" class="stats">
      <div class="stats__item">
        <span class="stats__label">订单侧（已付款）</span>
        <span class="stats__value">{{ money(data?.summary.orderFen) }}</span>
        <span class="stats__hint">{{ data?.summary.orderCount ?? 0 }} 单</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">流水侧（实收成功）</span>
        <span class="stats__value">{{ money(data?.summary.logFen) }}</span>
        <span class="stats__hint">{{ data?.summary.logCount ?? 0 }} 笔</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">差额（订单 − 实收）</span>
        <span class="stats__value" :class="(data?.summary.diffFen ?? 0) === 0 ? 'ok' : 'bad'">
          {{ signedMoney(data?.summary.diffFen) }}
        </span>
        <span class="stats__hint">正常必须为 ¥0.00</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">当日退款</span>
        <span class="stats__value">{{ money(data?.summary.refundFen) }}</span>
        <span class="stats__hint">
          {{ data?.summary.refundCount ?? 0 }} 笔 · 净入账 {{ money(data?.summary.netFen) }}
        </span>
      </div>
    </div>

    <el-card shadow="never" class="verdict">
      <div class="verdict__row">
        <el-tag :type="data?.summary.balanced ? 'success' : 'danger'" size="large">
          {{
            data?.summary.balanced
              ? '本地三头已对平'
              : `发现 ${data?.summary.diffCount ?? 0} 项差异`
          }}
        </el-tag>
        <span class="verdict__hint">
          已匹配 {{ data?.summary.matchedCount ?? 0 }} 单 ·
          <strong>不影响金额但影响凭证</strong>的差异（重复 / 缺交易号）也算「未平」
        </span>
      </div>
      <div class="verdict__types">
        <span v-for="s in data?.diffTypeStats ?? []" :key="s.type" class="verdict__type">
          <el-tag :type="DIFF_TAG[s.type]" size="small" effect="plain">{{ s.label }}</el-tag>
          <strong>{{ s.count }}</strong>
        </span>
      </div>
    </el-card>

    <el-card shadow="never" class="diffs">
      <template #header>
        <span>差异清单</span>
      </template>
      <el-table :data="data?.list ?? []" size="small" border empty-text="本日无差异">
        <el-table-column label="类型" width="180">
          <template #default="{ row }">
            <el-tag :type="DIFF_TAG[row.type as ReconDiffType]" size="small">
              {{ row.typeText }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="订单号" width="160">
          <template #default="{ row }">
            <span class="mono">{{ row.orderNo ?? '—' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="订单额" width="100" align="right">
          <template #default="{ row }">{{
            row.orderFen == null ? '—' : money(row.orderFen)
          }}</template>
        </el-table-column>
        <el-table-column label="实收额" width="100" align="right">
          <template #default="{ row }">{{ row.logFen == null ? '—' : money(row.logFen) }}</template>
        </el-table-column>
        <el-table-column label="差额" width="100" align="right">
          <template #default="{ row }">
            <span :class="(row.diffFen ?? 0) === 0 ? '' : 'bad'">
              {{ row.diffFen == null ? '—' : signedMoney(row.diffFen) }}
            </span>
          </template>
        </el-table-column>
        <el-table-column label="微信交易号" width="180">
          <template #default="{ row }">
            <span class="mono">{{ row.transactionId ?? '（缺失）' }}</span>
          </template>
        </el-table-column>
        <el-table-column label="情况 / 下一步" min-width="360">
          <template #default="{ row }">
            <div class="cell__status">{{ row.statusText }}</div>
            <div class="cell__next">{{ row.nextAction }}</div>
          </template>
        </el-table-column>
      </el-table>

      <el-pagination
        class="pager"
        layout="total, prev, pager, next"
        :current-page="page"
        :page-size="pageSize"
        :total="data?.total ?? 0"
        @current-change="onPage"
      />

      <p class="note">{{ data?.note }}</p>
    </el-card>
  </div>
</template>

<style lang="scss" scoped>
.channel {
  margin-bottom: $space-3;

  &__text {
    font-size: $fs-caption;
    line-height: 1.8;
  }
}

.bar {
  margin-bottom: $space-3;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-3;
  align-items: center;

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__right {
    margin-left: auto;
  }
}

.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: $space-3;
  margin-bottom: $space-3;

  &__item {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: $space-3;
    background: var(--el-fill-color-light);
    border-radius: 8px;
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

    &.bad {
      color: var(--el-color-danger);
    }
  }

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.verdict {
  margin-bottom: $space-3;

  &__row {
    display: flex;
    flex-wrap: wrap;
    gap: $space-2;
    align-items: center;
  }

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__types {
    display: flex;
    flex-wrap: wrap;
    gap: $space-3;
    margin-top: $space-2;
  }

  &__type {
    display: inline-flex;
    gap: 6px;
    align-items: center;
    font-size: $fs-caption;
  }
}

.diffs {
  .mono {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px;
  }

  .bad {
    color: var(--el-color-danger);
    font-weight: 600;
  }

  .cell__status {
    font-size: 12px;
  }

  .cell__next {
    margin-top: 2px;
    color: $c-text-weak;
    font-size: $fs-caption;
    line-height: 1.6;
  }

  .pager {
    margin-top: $space-3;
  }
}

.note {
  margin: $space-3 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.8;
}
</style>
