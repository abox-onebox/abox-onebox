<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import { useNarrow } from '@/composables/use-narrow';

import {
  fetchFinanceCommissions,
  settleCommissions,
  type FinanceCommissionRow,
  type FinanceCommissionSummary,
  type SettleCommissionsResult,
} from '@/api/finance';

/**
 * P34 佣金结算明细（D34 · D35 · M3-13 · 模块 M35-02）
 *
 * ## 三个刻意的设计
 * 1. **按「出餐日」而不是区间**：佣金明细是「一天一张表」的核对习惯，
 *    点开某一天逐单看。要看多日就逐日切换 —— 不让它长成第二个区间选择器。
 * 2. **`rate` / `leaderLevel` 是结算时的快照**（C2）：团长后来晋级了，
 *    历史行仍显示当时的等级与费率。拿它去对照「现在的佣金比例」必然对不上，这是设计如此，
 *    故列头直接写「费率（快照）」。
 * 3. **「佣金入账」按钮处理的是 `pending` 佣金**（两段式：T 日确认计佣写 `pending`、
 *    T+1 02:00 跑批入账），故 `pending` 是**每天的常态**、通常**不是 0 条**；
 *    返回 0 条只在「当天没有新确认订单」时出现。**服务端会把口径放在 `note` 里**，
 *    本页原样弹出，绝不吞掉；否则运营会以为「按钮坏了」。
 *
 * ⚠️ 端上不做金额计算：净额 / 冲销 / 按等级拆分全部取服务端 `summary`
 *    （它按**同一过滤条件的全量**统计，翻页不会跳数）。
 */
const COMMISSION_STATUS_OPTIONS = [
  { value: 'all', label: '全部' },
  { value: 'settled', label: '已入账' },
  { value: 'pending', label: '待入账' },
  { value: 'cancelled', label: '已冲销' },
];

const loading = ref(false);
const settling = ref(false);
const date = ref(defaultDate());
const status = ref('all');
const type = ref('all');
const keyword = ref('');
const rows = ref<FinanceCommissionRow[]>([]);
const summary = ref<FinanceCommissionSummary | null>(null);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);

/**
 * 窄屏（S8）判据 —— 唯一真源见 `composables/use-narrow.ts`。
 * 仅用于**表格 ↔ 卡片列表**的切换：11 列宽表在手机上没有可用的降级写法
 * （逐列隐藏会丢掉「费率快照 / 计佣基数」这些对账必需列，横向滚动则每行都要左右拖）。
 */
const { narrow } = useNarrow();

const money = (fen?: number | null) => `¥${((fen ?? 0) / 100).toFixed(2)}`;
/** 冲销是负值 —— 展示为 -¥x.xx */
const signedMoney = (fen?: number | null) => {
  const v = fen ?? 0;
  return v < 0 ? `-¥${(-v / 100).toFixed(2)}` : `¥${(v / 100).toFixed(2)}`;
};

/** 北京时间「今天」 */
function defaultDate(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

const statusTagType = (s: string) =>
  s === 'settled' ? 'success' : s === 'pending' ? 'warning' : 'info';

async function load() {
  loading.value = true;
  try {
    const res = await fetchFinanceCommissions({
      date: date.value || undefined,
      status: status.value === 'all' ? undefined : status.value,
      type: type.value === 'all' ? undefined : type.value,
      keyword: keyword.value.trim() || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = res.list ?? [];
    summary.value = res.summary ?? null;
    total.value = res.total ?? 0;
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

async function reload() {
  page.value = 1;
  await load();
}

/**
 * D35 佣金入账（幂等 · 可重复点）
 *
 * 日期有值 → 只处理该出餐日；日期清空 → 处理**全部**待入账（文案里必须说清，
 * 否则运营不知道自己这次点的是「一天」还是「所有天」）。
 */
async function onSettle() {
  const scope = date.value ? `仅「${date.value}」这一出餐日` : '**全部**出餐日';
  try {
    await ElMessageBox.confirm(
      `将把 ${scope} 的「待入账」佣金计入团长余额。\n\n` +
        '· 整批单事务：要么全入账、要么全不入账\n' +
        '· 幂等：可安全重复点击，已入账的会跳过\n' +
        '· 口径：两段式下 `pending` 是每天的常态（T 日确认计佣 → T+1 02:00 入账），返回 0 条只在当天无新确认订单时出现',
      '佣金入账（补跑）',
      { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return; // 用户取消
  }

  settling.value = true;
  try {
    const res: SettleCommissionsResult = await settleCommissions({
      date: date.value || undefined,
    });

    const lines = [
      `扫描 ${res.scanned} 条 · 入账 ${res.settled} 条 · 跳过 ${res.skipped} 条`,
      `入账金额 ${money(res.amountFen)} · 计入份数 ${res.quantity}`,
    ];
    if (res.leaders?.length) {
      lines.push('');
      lines.push('按团长：');
      for (const l of res.leaders) {
        lines.push(
          `· ${l.leaderName || `#${l.leaderId}`}：${money(l.amountFen)}（${l.settled} 条）`,
        );
      }
    }
    if (res.skippedReasons?.length) {
      lines.push('');
      lines.push('跳过原因：');
      for (const r of res.skippedReasons) lines.push(`· ${r}`);
    }
    if (res.note) {
      lines.push('');
      lines.push(res.note);
    }

    await ElMessageBox.alert(lines.join('\n'), '佣金入账结果', {
      confirmButtonText: '知道了',
      customStyle: { whiteSpace: 'pre-line', maxWidth: '520px' },
    });
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '入账失败');
  } finally {
    settling.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page-container">
    <h2 class="page-container__title">团长佣金结算（4 级阶梯 · 8/9/10/12%）</h2>
    <p class="page-container__meta">
      原型页 / 模块：P34 · M35-02 ｜ 等级与费率取<strong>结算时的快照</strong>（C2）· 计佣基数 =
      <strong>实发份数</strong>（不含冲销）· 佣金入账 = M4 跑批（T+1 02:00）的同一执行口
    </p>

    <el-card shadow="never" class="bar">
      <div class="toolbar">
        <el-date-picker
          v-model="date"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="出餐日（默认今日）"
          @change="reload"
        />
        <el-radio-group v-model="status" @change="reload">
          <el-radio-button
            v-for="opt in COMMISSION_STATUS_OPTIONS"
            :key="opt.value"
            :label="opt.value"
          >
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
        <el-select v-model="type" class="sel" @change="reload">
          <el-option label="全部类型" value="all" />
          <el-option label="正常计佣" value="normal" />
          <el-option label="退款冲销" value="reversal" />
        </el-select>
        <el-input
          v-model="keyword"
          class="kw"
          clearable
          placeholder="订单号 / 团长姓名"
          @keyup.enter="reload"
          @clear="reload"
        />
        <div class="toolbar__right">
          <el-button :loading="loading" @click="load">刷新</el-button>
          <el-button type="primary" :loading="settling" @click="onSettle"
            >佣金入账（补跑）</el-button
          >
        </div>
      </div>
    </el-card>

    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">佣金净额</span>
        <span class="stats__value">{{ signedMoney(summary?.netFen) }}</span>
        <span class="stats__hint"
          >{{ summary?.count ?? 0 }} 条 · 计入 {{ summary?.quantity ?? 0 }} 份</span
        >
      </div>
      <div class="stats__item">
        <span class="stats__label">正常计佣</span>
        <span class="stats__value ok">{{ money(summary?.earnedFen) }}</span>
        <span class="stats__hint">正项</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">退款冲销</span>
        <span class="stats__value warn">{{ signedMoney(summary?.reversedFen) }}</span>
        <span class="stats__hint">C9 反向结算</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已入账 / 待入账</span>
        <span class="stats__value">{{ money(summary?.settledFen) }}</span>
        <span class="stats__hint">
          待入账 {{ money(summary?.pendingFen) }} · 已冲销 {{ money(summary?.cancelledFen) }}
        </span>
      </div>
    </div>

    <el-card v-if="summary?.byLevel?.length" shadow="never" class="levels">
      <template #header>按团长等级拆分（同一过滤条件下的全量）</template>
      <el-table :data="summary.byLevel" size="small">
        <el-table-column prop="levelText" label="等级" width="120" />
        <el-table-column prop="count" label="条数" width="90" align="right" />
        <el-table-column prop="quantity" label="计入份数" width="110" align="right" />
        <el-table-column label="佣金金额" min-width="130" align="right">
          <template #default="{ row }"
            ><strong>{{ signedMoney(row.amountFen) }}</strong></template
          >
        </el-table-column>
      </el-table>
    </el-card>

    <el-card v-loading="loading" shadow="never">
      <!-- 桌面：11 列宽表。窄屏（S8）改渲染下方卡片列表 —— 见 useNarrow() 注释 -->
      <el-table v-if="rows.length && !narrow" :data="rows" size="small" stripe>
        <el-table-column prop="orderNo" label="订单号" min-width="150" />
        <el-table-column prop="mealDate" label="出餐日" width="105" />
        <el-table-column prop="leaderName" label="团长" min-width="90" />
        <el-table-column prop="phoneMasked" label="手机号" width="120" />
        <el-table-column label="等级（快照）" width="110">
          <template #default="{ row }">{{ row.leaderLevelText }}</template>
        </el-table-column>
        <el-table-column label="费率（快照）" width="110" align="right">
          <template #default="{ row }">{{ (row.rate * 100).toFixed(0) }}%</template>
        </el-table-column>
        <el-table-column label="计佣基数" min-width="110" align="right">
          <template #default="{ row }">{{ money(row.baseAmountFen) }}</template>
        </el-table-column>
        <el-table-column prop="quantity" label="份数" width="80" align="right" />
        <el-table-column label="佣金" width="110" align="right">
          <template #default="{ row }">
            <strong :class="{ neg: row.amountFen < 0 }">{{ signedMoney(row.amountFen) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="类型" width="100">
          <template #default="{ row }">{{ row.typeText }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="statusTagType(row.status)">{{ row.statusText }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="入账时间" min-width="160">
          <template #default="{ row }">{{ row.settledAt || '—' }}</template>
        </el-table-column>
      </el-table>
      <!--
        窄屏（S8 关键路径 2 / 2）：一单一张卡。
        信息层级 = 团长 / 佣金金额 / 状态 → 出餐日 + 订单号 → 六项明细。
        ⚠️ 明细列的**列名与桌面表完全一致**（含「（快照）」后缀）：两份表述若各写各的，
           运营在手机上看到的字段名与在电脑上看到的会漂移。
      -->
      <div v-else-if="rows.length" class="mcards">
        <div v-for="row in rows" :key="row.orderNo" class="mcard">
          <div class="mcard__hd">
            <span class="mcard__who">{{ row.leaderName || '—' }}</span>
            <el-tag size="small" :type="statusTagType(row.status)">{{ row.statusText }}</el-tag>
            <span class="mcard__amt" :class="{ neg: row.amountFen < 0 }">{{
              signedMoney(row.amountFen)
            }}</span>
          </div>

          <div class="mcard__sub">
            <span>{{ row.mealDate }}</span>
            <span class="mcard__no">{{ row.orderNo }}</span>
          </div>

          <dl class="mcard__kv">
            <dt>等级（快照）</dt>
            <dd>{{ row.leaderLevelText }}</dd>
            <dt>费率（快照）</dt>
            <dd>{{ (row.rate * 100).toFixed(0) }}%</dd>
            <dt>计佣基数</dt>
            <dd>{{ money(row.baseAmountFen) }}</dd>
            <dt>份数</dt>
            <dd>{{ row.quantity }}</dd>
            <dt>类型</dt>
            <dd>{{ row.typeText }}</dd>
            <dt>入账时间</dt>
            <dd>{{ row.settledAt || '—' }}</dd>
          </dl>
        </div>
      </div>

      <el-empty v-else description="该条件下没有佣金记录" />

      <el-pagination
        v-if="total > 0"
        v-model:current-page="page"
        v-model:page-size="pageSize"
        class="pager"
        layout="total, sizes, prev, pager, next"
        :total="total"
        :page-sizes="[20, 50, 100]"
        @current-change="load"
        @size-change="reload"
      />
    </el-card>

    <p class="note">
      提示：佣金入账按钮处理的是 `pending` 状态的佣金，它是 M4 跑批（T+1 02:00 佣金入账）的
      <strong>同一执行口</strong>。佣金两段式下 `pending` 是每天的常态（团长确认收货即计佣），
      故该按钮通常<strong>不是</strong> 0 条；结果弹窗会把服务端给出的口径原样展示。
    </p>
  </div>
</template>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-4;
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
    width: 200px;
  }

  .sel {
    width: 130px;
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
  padding: $space-3;
  margin-bottom: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__item {
    display: flex;
    flex-direction: column;
    min-width: 180px;
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

.levels {
  margin-bottom: $space-3;
}

.neg {
  color: var(--el-color-danger);
}

.pager {
  margin-top: $space-3;
  justify-content: flex-end;
}

.note {
  margin: 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.8;
}

/* ── 窄屏卡片列表（S8 关键路径 2 / 2）· 仅在 narrow 为真时渲染 ── */
.mcards {
  display: flex;
  flex-direction: column;
  gap: $space-2;
}

.mcard {
  padding: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__hd {
    display: flex;
    align-items: center;
    gap: $space-2;
  }

  &__who {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-weight: 600;
  }

  &__amt {
    flex: none;
    font-family: $font-family-num;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }

  &__sub {
    display: flex;
    gap: $space-2;
    margin-top: 2px;
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__no {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  /* 明细：两列（名 / 值）。列名与桌面表逐字一致，避免两份表述漂移 */
  &__kv {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px $space-2;
    margin: $space-2 0 0;

    dt {
      color: $c-text-weak;
      font-size: $fs-caption;
    }

    dd {
      margin: 0;
      font-size: $fs-caption;
      text-align: right;
    }
  }
}

/**
 * ── S8 · 窄屏（关键路径 2 / 2：团长佣金结算）──
 *
 * 祖先 `.ab-layout.is-narrow` 由 `layouts/default-layout.vue` 挂上
 * （唯一真源 = `composables/use-narrow.ts` 的 `NARROW_MAX`）。
 * ⚠️ 此处**故意不写 `@media`**：写第二份断点就与 JS 真源错开，而门禁看不见。
 */
.ab-layout.is-narrow {
  .toolbar {
    flex-direction: column;
    align-items: stretch;

    .kw,
    .sel {
      width: 100%;
    }

    :deep(.el-date-editor) {
      width: 100%;
    }

    // 4 个状态按钮等分铺满一行（3 字标签 × 4 ≈ 288px < 可用宽度，无需换行）
    :deep(.el-radio-group) {
      display: flex;
      width: 100%;

      .el-radio-button {
        flex: 1;
      }
    }

    &__right {
      width: 100%;
      margin-left: 0;

      :deep(.el-button) {
        flex: 1;
        min-height: 44px; // 移动端触摸目标
      }
    }
  }

  // 概览数字：两列（原 min-width 180px 在 320px 视口只能落一列，浪费纵向空间）
  .stats {
    gap: $space-2;

    &__item {
      flex: 1 1 44%;
      min-width: 0;
    }

    &__value {
      font-size: $fs-h2;
    }
  }
}
</style>
