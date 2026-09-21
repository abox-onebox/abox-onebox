<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">
      订单详情
      <span v-if="detail" class="page-container__order mono">{{ detail.order.orderNo }}</span>
    </h2>
    <p class="page-container__meta">
      模块：M32-03/04/05 · 原型 P31 · 接口：D9 详情 / D10 手动改单 / D11 强制退款 · 含该单
      <strong>操作日志</strong>（谁在什么时候改了什么）
    </p>

    <el-empty v-if="!loading && !detail" description="未找到该订单">
      <el-button @click="back">返回订单中心</el-button>
    </el-empty>

    <template v-if="detail">
      <!-- ─────────────── 顶部操作 ─────────────── -->
      <div class="toolbar">
        <el-button @click="back">← 返回列表</el-button>
        <el-tag :type="statusTagType(detail.order.status)" effect="dark">
          {{ detail.order.statusText }}
        </el-tag>
        <span class="toolbar__meal">出餐日 {{ detail.order.mealDate }}</span>
        <div class="toolbar__right">
          <el-tooltip
            :disabled="detail.actions.canAdjust"
            :content="detail.actions.adjustBlockReason ?? ''"
            placement="top"
          >
            <el-button :disabled="!detail.actions.canAdjust" @click="adjustVisible = true">
              手动改单
            </el-button>
          </el-tooltip>
          <el-tooltip
            :disabled="detail.actions.canForceRefund"
            :content="detail.actions.refundBlockReason ?? ''"
            placement="top"
          >
            <el-button
              type="danger"
              plain
              :disabled="!detail.actions.canForceRefund"
              @click="openRefund"
            >
              强制退款
            </el-button>
          </el-tooltip>
          <!--
            C6 第二段的入口：订单停在 refund_applying 说明团长已提交代退申请，
            正确动作是去「退款管理」审批，而不是在这里强制退款（D11 会返回 40008 指路）。
          -->
          <el-button v-if="needRefundAudit" type="warning" @click="goRefundAudit">
            去退款审批
          </el-button>
        </div>
      </div>

      <el-alert
        v-if="!detail.actions.canAdjust && detail.actions.adjustBlockReason"
        type="info"
        :closable="false"
        show-icon
        :title="`不可改单：${detail.actions.adjustBlockReason}`"
        class="alert"
      />
      <el-alert
        v-if="!detail.actions.canForceRefund && detail.actions.refundBlockReason"
        type="info"
        :closable="false"
        show-icon
        :title="`不可退款：${detail.actions.refundBlockReason}`"
        class="alert"
      />

      <!-- ─────────────── 基本信息 ─────────────── -->
      <el-row :gutter="14" class="row">
        <el-col :span="12">
          <el-card shadow="never" class="card">
            <template #header><span class="card__title">下单人</span></template>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="昵称">
                {{ displayOr(detail.order.userName, '(未设昵称)') }}
              </el-descriptions-item>
              <el-descriptions-item label="手机号">
                {{ detail.order.phoneMasked }}
                <span class="card__note">已脱敏 · 完整号见「导出 CSV」</span>
              </el-descriptions-item>
              <el-descriptions-item label="所属团长">
                {{ displayOr(detail.leader?.name ?? detail.order.leaderName) }}
                <span v-if="detail.leader" class="card__note">
                  {{ detail.leader.level }} · 费率
                  {{ (detail.leader.commissionRate * 100).toFixed(0) }}%
                </span>
              </el-descriptions-item>
              <el-descriptions-item label="取餐地点">
                {{ displayOr(detail.order.buildingName) }}
                <span class="card__note">{{ detail.order.groupName }} 楼群</span>
              </el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>

        <el-col :span="12">
          <el-card shadow="never" class="card">
            <template #header><span class="card__title">金额构成</span></template>
            <el-descriptions :column="1" border size="small">
              <el-descriptions-item label="单价 × 份数">
                {{ fenToCny(detail.order.unitPriceFen) }} × {{ detail.order.quantity }}
              </el-descriptions-item>
              <el-descriptions-item label="订单总额">
                <strong>{{ fenToCny(detail.order.totalAmountFen) }}</strong>
              </el-descriptions-item>
              <el-descriptions-item label="余额抵扣">
                {{ fenToCny(detail.order.balanceUsedFen) }}
                <span class="card__note">下单冻结 / 支付后消费</span>
              </el-descriptions-item>
              <el-descriptions-item label="微信实付">
                {{ fenToCny(detail.order.payAmountFen) }}
              </el-descriptions-item>
              <el-descriptions-item label="可退金额">
                <strong class="card__refundable">
                  {{ fenToCny(detail.actions.refundableFen) }}
                </strong>
                <span class="card__note">= 总额 − 优惠（用户实际付出去的钱）</span>
              </el-descriptions-item>
            </el-descriptions>
          </el-card>
        </el-col>
      </el-row>

      <!-- ─────────────── 套餐菜品 ─────────────── -->
      <el-card shadow="never" class="card">
        <template #header>
          <span class="card__title">套餐与菜品</span>
          <span class="card__note">{{ displayOr(detail.order.setMealName) }}</span>
        </template>
        <el-table :data="detail.dishes" border size="small">
          <el-table-column prop="slotLabel" label="档位" width="90" />
          <el-table-column prop="name" label="菜品" min-width="180" />
          <el-table-column label="供应商" min-width="160">
            <template #default="{ row }">{{ displayOr(row.supplierName) }}</template>
          </el-table-column>
          <el-table-column label="结算价" width="130" align="right">
            <template #default="{ row }">
              <span :class="{ muted: row.shareAmountFen === null }">
                {{ row.shareAmountFen === null ? '按菜品供价' : fenToCny(row.shareAmountFen) }}
              </span>
            </template>
          </el-table-column>
        </el-table>
        <p class="hint">
          <strong>结算价口径（C9）</strong>：成本项逐菜与供应商协商，<strong>不写死</strong>；
          应付在 T+1 02:00 跑批时按「有效订单」汇总，此处只是套餐快照。
        </p>
      </el-card>

      <!-- ─────────────── 时间线 ─────────────── -->
      <el-card shadow="never" class="card">
        <template #header><span class="card__title">状态时间线</span></template>
        <el-steps :active="timelineActive" align-center finish-status="success" class="steps">
          <el-step
            v-for="n in detail.timeline"
            :key="n.node"
            :title="n.text"
            :description="n.done && n.at ? formatDateTime(n.at) : '—'"
            :status="n.done ? 'success' : 'wait'"
          />
        </el-steps>
      </el-card>

      <!-- ─────────────── 支付 / 退款 ─────────────── -->
      <el-row :gutter="14" class="row">
        <el-col :span="12">
          <el-card shadow="never" class="card">
            <template #header><span class="card__title">支付流水</span></template>
            <el-descriptions v-if="detail.payment" :column="1" border size="small">
              <el-descriptions-item label="微信交易号">
                <span class="mono">{{ displayOr(detail.payment.transactionId) }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="支付方式">
                {{ detail.payment.payMethod }}
              </el-descriptions-item>
              <el-descriptions-item label="金额">
                {{ fenToCny(detail.payment.amountFen) }}
              </el-descriptions-item>
              <el-descriptions-item label="状态">{{ detail.payment.status }}</el-descriptions-item>
              <el-descriptions-item label="支付时间">
                {{ formatDateTime(detail.payment.paidAt) }}
              </el-descriptions-item>
            </el-descriptions>
            <el-empty v-else description="无支付流水（未支付或全额余额支付）" :image-size="60" />
          </el-card>
        </el-col>

        <el-col :span="12">
          <el-card shadow="never" class="card">
            <template #header><span class="card__title">退款单（C6 三段式）</span></template>
            <el-descriptions v-if="detail.refund" :column="1" border size="small">
              <el-descriptions-item label="退款单号">
                <span class="mono">{{ detail.refund.refundNo }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="状态">
                <el-tag size="small" effect="plain">{{ detail.refund.statusText }}</el-tag>
                <span class="card__note">发起方：{{ detail.refund.applySourceText }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="退款金额">
                {{ fenToCny(detail.refund.amountFen) }}
              </el-descriptions-item>
              <el-descriptions-item label="原因">
                {{ displayOr(detail.refund.reasonTypeText) }}
                <span class="card__note">{{ detail.refund.reason }}</span>
              </el-descriptions-item>
              <el-descriptions-item label="反向结算">
                {{ detail.refund.reversed ? '已执行（佣金反冲 / 应付冲减 / 毛利留存）' : '未执行' }}
              </el-descriptions-item>
              <el-descriptions-item label="退款时间">
                {{ formatDateTime(detail.refund.refundedAt) }}
              </el-descriptions-item>
            </el-descriptions>
            <el-empty v-else description="无退款记录" :image-size="60" />
          </el-card>
        </el-col>
      </el-row>

      <el-card v-if="detail.commission.length" shadow="never" class="card">
        <template #header>
          <span class="card__title">佣金明细</span>
          <span class="card__note">退款冲销写独立负向行，原记录金额不改写（C9）</span>
        </template>
        <el-table :data="detail.commission" border size="small">
          <el-table-column prop="mealDate" label="出餐日" width="110" />
          <el-table-column label="类型" width="90">
            <template #default="{ row }">
              <el-tag
                size="small"
                effect="plain"
                :type="row.type === 'reversal' ? 'danger' : 'success'"
              >
                {{ row.type === 'reversal' ? '冲销' : '正常' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="等级 / 费率" width="130">
            <template #default="{ row }">
              {{ row.leaderLevel }} · {{ (row.rate * 100).toFixed(0) }}%
            </template>
          </el-table-column>
          <el-table-column label="计佣基数" width="110" align="right">
            <template #default="{ row }">{{ fenToCny(row.baseAmountFen) }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="份数" width="80" align="right" />
          <el-table-column label="金额" width="110" align="right">
            <template #default="{ row }">
              <span :class="row.amountFen < 0 ? 'negative' : ''">
                {{ fenToCny(row.amountFen) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column prop="status" label="状态" width="90" />
          <el-table-column label="结算时间" min-width="150">
            <template #default="{ row }">{{ formatDateTime(row.settledAt) }}</template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- ─────────────── 操作日志 ─────────────── -->
      <el-card shadow="never" class="card">
        <template #header>
          <span class="card__title">操作日志</span>
          <span class="card__note">
            该订单的全部后台写操作（含失败尝试）· 共 {{ detail.operationLogs.length }} 条
          </span>
        </template>
        <el-table
          v-if="detail.operationLogs.length"
          :data="detail.operationLogs"
          border
          size="small"
        >
          <el-table-column type="expand">
            <template #default="{ row }">
              <div class="logdetail">
                <div class="logdetail__col">
                  <h4>请求</h4>
                  <pre>{{ pretty(row.requestData) }}</pre>
                </div>
                <div class="logdetail__col">
                  <h4>响应</h4>
                  <pre>{{ pretty(row.responseData) }}</pre>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="时间" width="150">
            <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
          </el-table-column>
          <el-table-column label="操作人" width="130">
            <template #default="{ row }">
              {{ displayOr(row.operator, `#${row.adminUserId ?? '—'}`) }}
            </template>
          </el-table-column>
          <el-table-column prop="action" label="动作" min-width="150" />
          <el-table-column label="IP" width="130">
            <template #default="{ row }">
              <span class="mono">{{ displayOr(row.requestIp) }}</span>
            </template>
          </el-table-column>
        </el-table>
        <el-empty v-else description="暂无操作日志（该订单还没被后台改动过）" :image-size="60" />
      </el-card>
    </template>

    <!-- ─────────────── 改单（与列表页共用组件） ─────────────── -->
    <AdjustDialog
      v-model="adjustVisible"
      :order="detail?.order ?? null"
      :block-reason="detail?.actions.adjustBlockReason ?? null"
      @saved="load"
    />

    <!-- ─────────────── 强制退款 ─────────────── -->
    <el-dialog v-model="refundVisible" title="后台强制退款" width="560px">
      <el-alert
        type="warning"
        :closable="false"
        show-icon
        title="这是一条绕过「申请 → 审批」的例外通道（客诉兜底）"
        description="微信实付部分原路退回，余额抵扣部分即时退回余额，并同步执行反向结算（佣金反冲 / 应付冲减 / 平台毛利留存）。操作全程写入日志。"
        class="dialog__alert"
      />

      <el-descriptions :column="1" border size="small" class="dialog__head">
        <el-descriptions-item label="订单号">{{ detail?.order.orderNo }}</el-descriptions-item>
        <el-descriptions-item label="微信实付">
          {{ fenToCny(detail?.order.payAmountFen) }}
        </el-descriptions-item>
        <el-descriptions-item label="余额抵扣">
          {{ fenToCny(detail?.order.balanceUsedFen) }}
        </el-descriptions-item>
        <el-descriptions-item label="合计可退">
          <strong class="dialog__refundable">{{ fenToCny(detail?.actions.refundableFen) }}</strong>
        </el-descriptions-item>
      </el-descriptions>

      <el-form label-width="90px" class="dialog__form">
        <el-form-item label="退款原因" required>
          <el-input
            v-model="refundForm.reason"
            type="textarea"
            :rows="2"
            maxlength="200"
            show-word-limit
            placeholder="必填 —— 例：餐品异物，现场客诉"
          />
        </el-form-item>
        <el-form-item label="原因类型">
          <el-select v-model="refundForm.reasonType" style="width: 100%">
            <el-option
              v-for="r in REFUND_REASON_OPTIONS"
              :key="r.value"
              :label="r.label"
              :value="r.value"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="可退金额" required>
          <el-input v-model="refundForm.amountYuan" placeholder="照抄上面的合计可退金额">
            <template #prepend>¥</template>
          </el-input>
          <span class="dialog__tip"> 必须与可退金额一致 —— 这一步就是用来防「看错订单」的 </span>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="refundVisible = false">取消</el-button>
        <el-button type="danger" :loading="refunding" @click="submitRefund">确认退款</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  fetchAdminOrderDetail,
  forceRefundOrder,
  REFUND_REASON_OPTIONS,
  type AdminOrderDetail,
} from '@/api/order';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny, formatDateTime, yuanToFen } from '@/utils/format';
import AdjustDialog from './components/adjust-dialog.vue';

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const detail = ref<AdminOrderDetail | null>(null);

/** 已完成节点数 —— el-steps 的 active 语义 */
const timelineActive = computed(() => detail.value?.timeline.filter((n) => n.done).length ?? 0);

async function load(): Promise<void> {
  const orderNo = String(route.query.orderNo ?? '');
  if (!orderNo) {
    detail.value = null;
    return;
  }
  loading.value = true;
  try {
    detail.value = await fetchAdminOrderDetail(orderNo);
  } catch (e) {
    detail.value = null;
    ElMessage.error(e instanceof ApiError ? e.message : '订单详情加载失败');
  } finally {
    loading.value = false;
  }
}

function back(): void {
  router.push('/order/list');
}

/** 订单停在退款待审批 → 给出通往 P34 的直达入口（带着订单号，落地即筛到那一行） */
const needRefundAudit = computed(() => detail.value?.order.status === 'refund_applying');

function goRefundAudit(): void {
  const orderNo = detail.value?.order.orderNo;
  router.push({ path: '/finance/refund', query: orderNo ? { keyword: orderNo } : undefined });
}

function statusTagType(status: string): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
  if (status === 'completed') return 'success';
  if (status === 'pending_pay') return 'warning';
  if (status === 'refund_applying' || status === 'refunding') return 'danger';
  if (status === 'cancelled' || status === 'refunded') return 'info';
  return 'primary';
}

function pretty(v: unknown): string {
  if (v === null || v === undefined) return '—';
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// ------------------------------------------------------------ 改单

const adjustVisible = ref(false);

// ------------------------------------------------------------ 强制退款

const refundVisible = ref(false);
const refunding = ref(false);
const refundForm = reactive({
  reason: '',
  reasonType: 'other',
  amountYuan: '',
});

function openRefund(): void {
  refundForm.reason = '';
  refundForm.reasonType = 'other';
  // 预填可退金额：让运营「核对」而不是「回忆」—— 对不上就会被 40011 打回
  refundForm.amountYuan = ((detail.value?.actions.refundableFen ?? 0) / 100).toFixed(2);
  refundVisible.value = true;
}

async function submitRefund(): Promise<void> {
  const d = detail.value;
  if (!d) return;
  if (refundForm.reason.trim().length < 2) {
    ElMessage.warning('请填写退款原因（至少 2 个字）');
    return;
  }
  const amountFen = yuanToFen(refundForm.amountYuan);
  if (amountFen !== d.actions.refundableFen) {
    ElMessage.warning(`可退金额为 ${fenToCny(d.actions.refundableFen)}，与填写的金额不一致`);
    return;
  }

  await ElMessageBox.confirm(
    `将向用户退回 ${fenToCny(amountFen)}，并执行佣金反冲与应付冲减。退款不可撤销，确认？`,
    '确认强制退款',
    { type: 'warning', confirmButtonText: '确认退款', cancelButtonText: '再想想' },
  );

  refunding.value = true;
  try {
    const res = await forceRefundOrder(d.order.orderNo, {
      reason: refundForm.reason.trim(),
      reasonType: refundForm.reasonType,
      amountFen,
    });
    refundVisible.value = false;

    const notes = res.reversal.notes.length ? `\n\n注意：${res.reversal.notes.join('；')}` : '';
    await ElMessageBox.alert(
      `退款单 ${res.refundNo}\n` +
        `微信原路退 ${fenToCny(res.wxRefundedFen)} · 余额退回 ${fenToCny(res.balanceRefundedFen)}\n` +
        `佣金冲销 ${fenToCny(res.reversal.commissionReversedFen)}` +
        // 自营口径（2026-09-16）：退款**不冲减**供应商采购应付（半成品出餐日已交付）。
        // 这句话必须显式出现 —— 操作员看到应付数字没变时，要能分辨是设计而非漏算。
        '\n供应商采购应付：不冲减（半成品已交付，退款属自身经营风险）' +
        notes,
      '退款已发起',
      { confirmButtonText: '知道了' },
    );
    await load();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '强制退款失败');
  } finally {
    refunding.value = false;
  }
}

onMounted(load);
</script>

<style lang="scss" scoped>
.page-container__order {
  margin-left: $space-2;
  color: $c-text-weak;
  font-size: $fs-h2;
  font-weight: 400;
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-3;

  &__meal {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__right {
    display: flex;
    gap: $space-2;
    margin-left: auto;
  }
}

.alert {
  margin-bottom: $space-2;
}

.row {
  margin-bottom: 0;
}

.card {
  margin-bottom: $space-3;

  &__title {
    font-weight: 700;
  }

  &__note {
    margin-left: $space-2;
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__refundable {
    color: $c-warn-fg;
  }
}

.steps {
  padding: $space-2 0;
}

.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: $fs-caption;
}

.muted {
  color: $c-text-weak;
}

.negative {
  color: $c-warn-fg;
  font-weight: 700;
}

.hint {
  margin: $space-2 0 0;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}

.logdetail {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: $space-3;
  padding: $space-2 $space-3;
  background: $c-bg;

  &__col h4 {
    margin: 0 0 $space-1;
    font-size: $fs-caption;
  }

  &__col pre {
    max-height: 240px;
    margin: 0;
    overflow: auto;
    font-size: $fs-caption;
    white-space: pre-wrap;
    word-break: break-all;
  }
}

.dialog {
  &__head {
    margin-bottom: $space-3;
  }

  &__alert {
    margin-bottom: $space-3;
  }

  &__refundable {
    color: $c-warn-fg;
  }

  &__tip {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}
</style>
