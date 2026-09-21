<template>
  <div class="page-container">
    <h2 class="page-container__title">退款管理（C6 三段式审批）</h2>
    <p class="page-container__meta">
      模块：M35-05 · 原型 P34 · 接口：D40 退款流水 / D41 审批通过 / D42 审批驳回 · 数据源
      <code>ab_refund</code> + <code>ab_order</code>（手机号脱敏）
    </p>

    <!-- ─────────────── 流程说明（运营第一次打开要知道自己在哪一段） ─────────────── -->
    <el-alert type="info" :closable="false" class="flow">
      <template #title>
        截单后退款分三段：① 用户找团长 → 团长代退申请（<b>只登记，资金不动</b>）→ ② 本页审批 → ③
        通过即实际退款（微信实付原路退 + 余额抵扣退回余额 + 佣金冲销 /
        应付冲减，<b>平台毛利留存</b>）。 驳回则订单回到<b>申请前</b>的状态，资金同样零变动。
      </template>
    </el-alert>

    <!-- ─────────────── Tab ─────────────── -->
    <el-tabs v-model="activeTab" class="tabs" @tab-change="onTabChange">
      <el-tab-pane name="pending">
        <template #label>
          待审批
          <el-badge
            v-if="summary.pendingCount > 0"
            :value="summary.pendingCount"
            type="danger"
            class="tabs__badge"
          />
        </template>
      </el-tab-pane>
      <el-tab-pane label="已通过" name="approved" />
      <el-tab-pane label="已驳回" name="rejected" />
      <el-tab-pane label="已退款" name="refunded" />
      <el-tab-pane label="全部" name="all" />
    </el-tabs>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-date-picker
        v-model="query.mealDate"
        type="date"
        value-format="YYYY-MM-DD"
        placeholder="出餐日"
        clearable
        style="width: 160px"
        @change="reload"
      />
      <el-input
        v-model="query.keyword"
        placeholder="退款单号 / 订单号 / 用户昵称"
        clearable
        style="width: 240px"
        @keyup.enter="reload"
        @clear="reload"
      />
      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">查询</el-button>
      </div>
    </div>

    <!-- ─────────────── 汇总（按当前过滤条件的全量，不受分页影响） ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">待审批</span>
        <span class="stats__value stats__value--warn">{{ summary.pendingCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">待审批金额</span>
        <span class="stats__value">{{ fenToCny(summary.pendingAmountFen) }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已通过（含退款中）</span>
        <span class="stats__value">{{ summary.approvedCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已退款笔数</span>
        <span class="stats__value stats__value--ok">{{ summary.refundedCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已退款金额</span>
        <span class="stats__value">{{ fenToCny(summary.refundedAmountFen) }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">已驳回</span>
        <span class="stats__value stats__value--muted">{{ summary.rejectedCount }}</span>
      </div>
    </div>

    <!-- ─────────────── 列表 ─────────────── -->
    <el-table v-loading="loading" :data="rows" class="table" stripe>
      <el-table-column label="退款单号" min-width="180">
        <template #default="{ row }">
          <div class="stack">
            <span class="mono">{{ asRow(row).refundNo }}</span>
            <span class="stack__sub mono">订单 {{ asRow(row).orderNo }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="出餐日 / 份数" width="130">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(asRow(row).mealDate) }}</span>
            <span class="stack__sub">{{ asRow(row).quantity ?? '—' }} 份</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="用户" min-width="130">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(asRow(row).user.nickname) }}</span>
            <span class="stack__sub mono">{{ displayOr(asRow(row).user.phoneMasked) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="发起团长" min-width="110">
        <template #default="{ row }">
          <span>{{ displayOr(asRow(row).leader?.realName) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="退款金额" min-width="150">
        <template #default="{ row }">
          <div class="stack">
            <span class="amount">{{ fenToCny(asRow(row).amountFen) }}</span>
            <span class="stack__sub">
              微信 {{ fenToCny(asRow(row).wxAmountFen) }} · 余额
              {{ fenToCny(asRow(row).balanceAmountFen) }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="来源 / 原因" min-width="140">
        <template #default="{ row }">
          <div class="stack">
            <el-tag size="small" :type="sourceTagType(asRow(row).applySource)">
              {{ asRow(row).applySourceText }}
            </el-tag>
            <span class="stack__sub">{{ displayOr(asRow(row).reasonTypeText) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="原因说明" min-width="160" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="muted">{{ displayOr(asRow(row).reason) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="statusTagType(asRow(row).status)">
            {{ asRow(row).statusText }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="申请 / 审批时间" min-width="160">
        <template #default="{ row }">
          <div class="stack">
            <span class="stack__sub">{{ formatDateTime(asRow(row).createdAt) }}</span>
            <span class="stack__sub">
              {{ asRow(row).auditAt ? formatDateTime(asRow(row).auditAt) : '待审批' }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="审批留痕" min-width="150" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="muted">{{ displayOr(asRow(row).auditRemark) }}</span>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <template v-if="asRow(row).canApprove">
            <el-button link type="primary" @click="openApprove(asRow(row))">通过</el-button>
            <el-button link type="danger" @click="openReject(asRow(row))">驳回</el-button>
          </template>
          <el-tooltip
            v-else
            :content="asRow(row).blockReason ?? '当前状态不可审批'"
            placement="top"
          >
            <span class="muted">—</span>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next"
        @size-change="reload"
        @current-change="reload"
      />
    </div>

    <!-- ─────────────── D41 通过 ─────────────── -->
    <el-dialog v-model="approveVisible" title="审批通过 · 实际退款" width="620px">
      <div v-if="current" class="dialog__body">
        <el-alert type="warning" :closable="false" class="dialog__block">
          <template #title>
            本操作会<b>真的把钱退出去</b>，且不可撤销。请核对订单号与金额后再确认。
          </template>
        </el-alert>

        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="退款单号">
            <span class="mono">{{ current.refundNo }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="订单号">
            <span class="mono">{{ current.orderNo }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="用户">
            {{ displayOr(current.user.nickname) }} · {{ displayOr(current.user.phoneMasked) }}
          </el-descriptions-item>
          <el-descriptions-item label="发起团长">
            {{ displayOr(current.leader?.realName) }}
          </el-descriptions-item>
          <el-descriptions-item label="退款金额（服务端口径）">
            <b class="amount">{{ fenToCny(current.amountFen) }}</b>
          </el-descriptions-item>
        </el-descriptions>

        <div class="chain">
          <div class="chain__title">执行链预览</div>
          <ol class="chain__list">
            <li>
              微信实付 <b>{{ fenToCny(current.wxAmountFen) }}</b> 走通道<b>原路退回</b>
            </li>
            <li>
              余额抵扣 <b>{{ fenToCny(current.balanceAmountFen) }}</b> <b>单独退回余额</b>
              （不走微信，否则会被拒或形成重复出款）
            </li>
            <li>
              反向结算：佣金写负向流水冲销、供应商应付冲减、<b>平台毛利留存</b>（原记录不改写）
            </li>
            <li>订单转「已退款」，用户端立即可见</li>
          </ol>
        </div>

        <el-input
          v-model="approveRemark"
          type="textarea"
          :rows="2"
          maxlength="200"
          show-word-limit
          placeholder="审批备注（选填，留痕用）"
        />
      </div>
      <template #footer>
        <el-button @click="approveVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="doApprove">确认退款</el-button>
      </template>
    </el-dialog>

    <!-- ─────────────── D42 驳回 ─────────────── -->
    <el-dialog v-model="rejectVisible" title="审批驳回" width="560px">
      <div v-if="current" class="dialog__body">
        <el-alert type="info" :closable="false" class="dialog__block">
          <template #title>
            驳回<b>不动任何资金</b>；订单将回到申请前的状态：
            <b>{{ displayOr(current.orderStatusBeforeText) }}</b>
            <span class="dialog__tip">（当前为「{{ displayOr(current.orderStatusText) }}」）</span>
          </template>
        </el-alert>
        <el-input
          v-model="rejectReason"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="驳回理由（必填，至少 2 个字 —— 团长与用户都会看到这个结论）"
        />
      </div>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="doReject">确认驳回</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  approveRefund,
  fetchAdminRefunds,
  rejectRefund,
  type RefundRow,
  type RefundsSummary,
  type RefundStatusValue,
  type RefundTabValue,
} from '@/api/finance';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny, formatDateTime } from '@/utils/format';

const route = useRoute();

const loading = ref(false);
const submitting = ref(false);
const rows = ref<RefundRow[]>([]);
const total = ref(0);
const activeTab = ref<RefundTabValue>('pending');

const summary = reactive<RefundsSummary>({
  pendingCount: 0,
  pendingAmountFen: 0,
  approvedCount: 0,
  refundedCount: 0,
  refundedAmountFen: 0,
  rejectedCount: 0,
});

const query = reactive({
  mealDate: '' as string,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const current = ref<RefundRow | null>(null);
const approveVisible = ref(false);
const approveRemark = ref('');
const rejectVisible = ref(false);
const rejectReason = ref('');

/**
 * el-table 插槽的 `row` 是宽松的 `DefaultRow`，直接传给收窄了类型的函数会 TS2345。
 * 在**函数入口**做一次断言，避免把 `as` 扩散到整个模板。
 */
function asRow(raw: unknown): RefundRow {
  return raw as RefundRow;
}

function sourceTagType(source: string): 'info' | 'warning' | 'danger' {
  if (source === 'leader') return 'warning';
  if (source === 'admin') return 'danger';
  return 'info';
}

function statusTagType(status: RefundStatusValue): 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'refunded') return 'success';
  if (status === 'applying') return 'warning';
  if (status === 'rejected' || status === 'failed') return 'danger';
  return 'info';
}

function onTabChange(): void {
  query.page = 1;
  reload();
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchAdminRefunds({
      tab: activeTab.value,
      mealDate: query.mealDate || undefined,
      keyword: query.keyword.trim() || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list ?? [];
    total.value = res.total ?? 0;
    Object.assign(summary, res.summary);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '退款列表加载失败');
  } finally {
    loading.value = false;
  }
}

function openApprove(row: RefundRow): void {
  current.value = row;
  approveRemark.value = '';
  approveVisible.value = true;
}

async function doApprove(): Promise<void> {
  if (!current.value) return;
  submitting.value = true;
  try {
    const res = await approveRefund(current.value.id, {
      remark: approveRemark.value.trim() || undefined,
    });
    approveVisible.value = false;
    ElMessage.success(`退款已完成：${res.executionChain.join(' · ')}`);
    await reload();
  } catch (e) {
    // ⚠️ 不关弹窗：退款失败（如通道抖动 40010）时运营要能原样重试
    ElMessage.error(e instanceof ApiError ? e.message : '审批失败');
  } finally {
    submitting.value = false;
  }
}

function openReject(row: RefundRow): void {
  current.value = row;
  rejectReason.value = '';
  rejectVisible.value = true;
}

async function doReject(): Promise<void> {
  if (!current.value) return;
  if (rejectReason.value.trim().length < 2) {
    ElMessage.warning('请填写驳回理由（至少 2 个字）');
    return;
  }
  submitting.value = true;
  try {
    const res = await rejectRefund(current.value.id, rejectReason.value.trim());
    rejectVisible.value = false;
    ElMessage.success(`已驳回；订单已回到「${res.orderStatusText}」，资金未变动`);
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '驳回失败');
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  // 从订单详情「去退款审批」跳来时带 orderNo：落地即筛到那一行，不让人自己再找一遍
  const kw = String(route.query.keyword ?? '').trim();
  if (kw) query.keyword = kw;
  reload();
});
</script>

<style lang="scss" scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-3;

  &__right {
    display: flex;
    gap: $space-2;
    margin-left: auto;
  }
}

.flow {
  margin-bottom: $space-3;
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
    font-size: $fs-h2;
    font-weight: 700;

    &--ok {
      color: $c-ok-fg;
    }

    &--warn {
      color: $c-warn-fg;
    }

    &--muted {
      color: $c-text-weak;
    }
  }
}

.tabs {
  margin-bottom: $space-1;

  &__badge {
    margin-left: $space-1;
    transform: translateY(-2px);
  }
}

.table {
  margin-bottom: $space-3;
}

.stack {
  display: flex;
  flex-direction: column;
  line-height: 1.4;

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: $fs-caption;
}

.muted {
  color: $c-text-weak;
}

.amount {
  font-weight: 700;
  color: $c-warn-fg;
}

.pager {
  display: flex;
  justify-content: flex-end;
}

.dialog {
  &__body {
    display: flex;
    flex-direction: column;
    gap: $space-3;
  }

  &__block {
    margin-bottom: 0;
  }

  &__tip {
    margin-left: $space-1;
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.chain {
  padding: $space-2 $space-3;
  background: $c-bg;
  border-radius: $radius-sm;

  &__title {
    margin-bottom: $space-1;
    color: $c-text-weak;
    font-size: $fs-caption;
    font-weight: 700;
  }

  &__list {
    margin: 0;
    padding-left: 18px;
    font-size: $fs-caption;
    line-height: 1.9;
  }
}
</style>
