<template>
  <div class="page-container">
    <h2 class="page-container__title">提现审批（C11 灵活用工出款）</h2>
    <p class="page-container__meta">
      模块：M35-08 · 原型 P34 · 接口：D45 提现单列表 / D46 批准 / D46a 驳回 / D46b 到账回执 / D46c
      打款失败 · 数据源 <code>ab_withdraw</code> + <code>ab_balance</code>（收款账号为脱敏存储）
    </p>

    <!-- ─────────────── 流程说明（运营第一次打开要知道自己在哪一段） ─────────────── -->
    <el-alert type="info" :closable="false" class="flow">
      <template #title>
        团长提交提现的那一瞬，钱就已从「可用余额」挪进「冻结」——
        <b>本页是唯一能让它继续往前走的地方</b>。四动作： <b>批准</b>（只登记批次，不动钱）→
        <b>到账登记</b>（钱正式出平台）； 或 <b>驳回</b> /
        <b>打款失败</b>（两者都<b>原路解冻</b>，钱退回团长可用余额）。 一期走人工通道（导出清单 →
        提交灵活用工平台 → 拿回执回本页登记）。
      </template>
    </el-alert>

    <!-- ─────────────── Tab ─────────────── -->
    <el-tabs v-model="activeTab" class="tabs" @tab-change="onTabChange">
      <el-tab-pane name="review">
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
      <el-tab-pane name="payout">
        <template #label>
          待打款
          <el-badge
            v-if="summary.approvedCount > 0"
            :value="summary.approvedCount"
            type="warning"
            class="tabs__badge"
          />
        </template>
      </el-tab-pane>
      <el-tab-pane label="已终态" name="done" />
      <el-tab-pane label="全部" name="all" />
    </el-tabs>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-select
        v-model="query.status"
        placeholder="全部状态"
        clearable
        style="width: 150px"
        @change="reload()"
      >
        <el-option
          v-for="opt in statusOptions"
          :key="opt.value"
          :label="opt.label"
          :value="opt.value"
        />
      </el-select>
      <el-input
        v-model="query.keyword"
        placeholder="提现单号 / 收款人 / 团长姓名 / 用户昵称"
        clearable
        style="width: 260px"
        @keyup.enter="reload()"
        @clear="reload()"
      />
      <el-input
        v-model="query.payoutBatchNo"
        placeholder="批次号（如 PB20260917）"
        clearable
        style="width: 190px"
        @keyup.enter="reload()"
        @clear="reload()"
      />
      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">查询</el-button>
      </div>
    </div>

    <!-- ─────────────── 汇总 ─────────────── -->
    <div class="stats">
      <div class="stats__group">
        <div class="stats__caption">在途（全量 · 时点量，不随筛选变化）</div>
        <div class="stats__row">
          <div class="stats__item">
            <span class="stats__label">待审批</span>
            <span class="stats__value stats__value--warn">{{ summary.pendingCount }}</span>
          </div>
          <div class="stats__item">
            <span class="stats__label">待审批金额</span>
            <span class="stats__value">{{ fenToCny(summary.pendingAmountFen) }}</span>
          </div>
          <div class="stats__item">
            <span class="stats__label">待打款</span>
            <span class="stats__value">{{ summary.approvedCount }}</span>
          </div>
          <div class="stats__item">
            <span class="stats__label">待打款金额</span>
            <span class="stats__value">{{ fenToCny(summary.approvedAmountFen) }}</span>
          </div>
          <div class="stats__item">
            <span class="stats__label">提现占用冻结额</span>
            <span class="stats__value stats__value--warn">
              {{ fenToCny(summary.frozenByWithdrawFen) }}
            </span>
          </div>
        </div>
      </div>

      <div class="stats__group">
        <div class="stats__caption">本筛选范围（全量，不受分页影响）</div>
        <div class="stats__row">
          <div class="stats__item">
            <span class="stats__label">已到账</span>
            <span class="stats__value stats__value--ok">{{ summary.paidCount }}</span>
          </div>
          <div class="stats__item">
            <span class="stats__label">已到账金额</span>
            <span class="stats__value">{{ fenToCny(summary.paidAmountFen) }}</span>
          </div>
          <div class="stats__item">
            <span class="stats__label">已解冻（驳回 + 失败）</span>
            <span class="stats__value stats__value--muted">{{ summary.releasedCount }}</span>
          </div>
          <div class="stats__item">
            <span class="stats__label">已解冻金额</span>
            <span class="stats__value stats__value--muted">
              {{ fenToCny(summary.releasedAmountFen) }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- ─────────────── 权限提示（无审批权时说明为什么全是灰的） ─────────────── -->
    <el-alert v-if="!canAudit" type="warning" :closable="false" class="flow">
      <template #title>
        当前账号<b>可查看但不可操作</b>：四动作限定 <code>super_admin</code> / <code>admin</code> /
        <code>finance</code> 三种角色（<code>operator</code> 可读不可批）。如需处理请让财务执行。
      </template>
    </el-alert>

    <!-- ─────────────── 列表 ─────────────── -->
    <el-table v-loading="loading" :data="rows" class="table" stripe>
      <el-table-column label="提现单号" min-width="185">
        <template #default="{ row }">
          <div class="stack">
            <span class="mono">{{ asRow(row).withdrawNo }}</span>
            <span class="stack__sub">{{ formatDateTime(asRow(row).createdAt) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="团长 / 用户" min-width="140">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(asRow(row).leader?.realName ?? asRow(row).user.nickname) }}</span>
            <span class="stack__sub">
              <span v-if="asRow(row).leader" class="tag-inline">
                {{ displayOr(asRow(row).leader?.levelText) }}
              </span>
              <span class="mono">{{ displayOr(asRow(row).user.phoneMasked) }}</span>
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="申请金额 / 到账" min-width="160">
        <template #default="{ row }">
          <div class="stack">
            <span class="amount">{{ fenToCny(asRow(row).amountFen) }}</span>
            <!-- ⚠️ 到账前「实付」在库里仍是申请额，不是结论 —— 故显示「待登记」而不是 ¥0 个税 -->
            <span v-if="asRow(row).actualKnown" class="stack__sub">
              实付 {{ fenToCny(asRow(row).actualFen) }} · 代扣
              {{ fenToCny(asRow(row).taxWithheldFen) }}
            </span>
            <span v-else class="stack__sub muted">实付待到账登记</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="收款信息" min-width="170">
        <template #default="{ row }">
          <div class="stack">
            <span>
              {{ displayOr(asRow(row).receiveName) }}
              <span class="stack__sub">· {{ asRow(row).receiveTypeText }}</span>
            </span>
            <span class="stack__sub mono">{{ asRow(row).receiveAccount }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="状态 / 批次" min-width="150">
        <template #default="{ row }">
          <div class="stack">
            <el-tag size="small" :type="statusTagType(asRow(row).status)">
              {{ asRow(row).statusText }}
            </el-tag>
            <span class="stack__sub mono">{{ displayOr(asRow(row).payoutBatchNo) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="审批 / 失败留痕" min-width="180" show-overflow-tooltip>
        <template #default="{ row }">
          <span class="muted">
            {{ displayOr(asRow(row).failReason ?? asRow(row).auditRemark) }}
          </span>
        </template>
      </el-table-column>

      <el-table-column label="时间线" min-width="150">
        <template #default="{ row }">
          <div class="stack">
            <span class="stack__sub">
              审批 {{ asRow(row).auditAt ? formatDateTime(asRow(row).auditAt) : '—' }}
            </span>
            <span class="stack__sub">
              到账 {{ asRow(row).paidAt ? formatDateTime(asRow(row).paidAt) : '—' }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="160" fixed="right">
        <template #default="{ row }">
          <template v-if="asRow(row).canApprove || asRow(row).canReject">
            <el-button
              link
              type="primary"
              :disabled="!asRow(row).canApprove"
              @click="openApprove(asRow(row))"
            >
              批准
            </el-button>
            <el-button link type="danger" @click="openReject(asRow(row))">驳回</el-button>
          </template>
          <template v-else-if="asRow(row).canMarkPaid || asRow(row).canMarkFailed">
            <el-button link type="primary" @click="openPaid(asRow(row))">到账登记</el-button>
            <el-button link type="danger" @click="openFail(asRow(row))">打款失败</el-button>
          </template>
          <el-tooltip
            v-else
            :content="asRow(row).blockReason ?? '当前状态不可处理'"
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
        @size-change="reload()"
        @current-change="reload()"
      />
    </div>

    <!-- ─────────────── D46 批准 ─────────────── -->
    <el-dialog v-model="approveVisible" title="批准提现 · 登记出款批次" width="600px">
      <div v-if="current" class="dialog__body">
        <el-alert type="info" :closable="false" class="dialog__block">
          <template #title>
            批准<b>不动任何资金</b>：这笔钱在团长提交申请时已被冻结。批准只是同意把它纳入出款批次，
            真正的出款发生在<b>下一步「到账登记」</b>。
          </template>
        </el-alert>

        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="提现单号">
            <span class="mono">{{ current.withdrawNo }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="收款人">
            {{ displayOr(current.receiveName) }} · {{ current.receiveTypeText }} ·
            <span class="mono">{{ current.receiveAccount }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="申请金额">
            <b class="amount">{{ fenToCny(current.amountFen) }}</b>
          </el-descriptions-item>
          <el-descriptions-item label="出款通道">{{
            current.payoutChannelText
          }}</el-descriptions-item>
          <el-descriptions-item v-if="current.leader" label="团长当前资产">
            可用 {{ fenToCny(current.leader.balanceFen) }} · 冻结
            {{ fenToCny(current.leader.frozenFen) }} · 待入账佣金
            {{ fenToCny(current.leader.pendingCommissionFen) }}
          </el-descriptions-item>
        </el-descriptions>

        <el-form label-width="96px">
          <el-form-item label="出款批次">
            <el-input
              v-model="approveBatchNo"
              placeholder="留空则按审批日自动生成（PB + 日期）"
              clearable
            />
          </el-form-item>
          <el-form-item label="审批备注">
            <el-input
              v-model="approveRemark"
              type="textarea"
              :rows="2"
              maxlength="200"
              show-word-limit
              placeholder="选填，留痕用"
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="approveVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="doApprove">确认批准</el-button>
      </template>
    </el-dialog>

    <!-- ─────────────── D46a 驳回 ─────────────── -->
    <el-dialog v-model="rejectVisible" title="驳回提现申请" width="560px">
      <div v-if="current" class="dialog__body">
        <el-alert type="warning" :closable="false" class="dialog__block">
          <template #title>
            驳回会<b>立即解冻</b> {{ fenToCny(current.amountFen) }} 退回团长可用余额（<code
              >total_in</code
            >
            / <code>total_out</code> 都不动 —— 钱本来就没进出平台）。<b>此操作不可撤销</b>。
          </template>
        </el-alert>
        <el-input
          v-model="rejectReason"
          type="textarea"
          :rows="3"
          maxlength="200"
          show-word-limit
          placeholder="驳回理由（必填，至少 2 个字 —— 团长会在「提现记录」里看到这句话）"
        />
      </div>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="doReject">确认驳回并解冻</el-button>
      </template>
    </el-dialog>

    <!-- ─────────────── D46b 到账登记 ─────────────── -->
    <el-dialog v-model="paidVisible" title="到账登记 · 钱正式出平台" width="640px">
      <div v-if="current" class="dialog__body">
        <el-alert type="warning" :closable="false" class="dialog__block">
          <template #title>
            请照<b>灵活用工平台回执</b>填写。登记后该笔提现转「已到账」，
            冻结额释放、计入累计支出。<b>登记完就结束了，不能改</b>。
          </template>
        </el-alert>

        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="提现单号">
            <span class="mono">{{ current.withdrawNo }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="收款人">
            {{ displayOr(current.receiveName) }} ·
            <span class="mono">{{ current.receiveAccount }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="申请金额">
            <b class="amount">{{ fenToCny(current.amountFen) }}</b>
          </el-descriptions-item>
        </el-descriptions>

        <el-form label-width="106px">
          <el-form-item label="平台代扣个税">
            <el-input-number
              v-model="paidTaxYuan"
              :min="0"
              :precision="2"
              :step="1"
              :controls="false"
              class="num"
              placeholder="元"
            />
            <span class="sub ml-sm">元（留空 = 按无代扣处理）</span>
          </el-form-item>
          <el-form-item label="实际到账">
            <el-input-number
              v-model="paidActualYuan"
              :min="0"
              :precision="2"
              :step="1"
              :controls="false"
              class="num"
              placeholder="元"
            />
            <span class="sub ml-sm">元（留空 = 由申请额减代扣推出）</span>
          </el-form-item>

          <!-- 与后端同一套推导规则，让「系统替你假设了什么」在提交前就可见 -->
          <el-form-item label=" ">
            <el-alert :type="paidHint.type" :closable="false" class="dialog__block">
              <template #title>{{ paidHint.text }}</template>
            </el-alert>
          </el-form-item>

          <el-form-item label="到账时间">
            <el-date-picker
              v-model="paidAt"
              type="datetime"
              value-format="YYYY-MM-DD HH:mm:ss"
              placeholder="留空 = 取当前登记时刻"
              clearable
              style="width: 220px"
            />
            <span class="sub ml-sm">平台回执上的时间；补录历史回执时填</span>
          </el-form-item>
          <el-form-item label="出款批次">
            <el-input v-model="paidBatchNo" placeholder="留空则沿用已登记批次" clearable />
          </el-form-item>
          <el-form-item label="备注">
            <el-input
              v-model="paidRemark"
              type="textarea"
              :rows="2"
              maxlength="256"
              show-word-limit
              placeholder="建议填平台回执流水号，便于日后查账"
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="paidVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="submitting"
          :disabled="paidHint.type === 'error'"
          @click="doMarkPaid"
        >
          确认到账
        </el-button>
      </template>
    </el-dialog>

    <!-- ─────────────── D46c 打款失败 ─────────────── -->
    <el-dialog v-model="failVisible" title="登记打款失败" width="560px">
      <div v-if="current" class="dialog__body">
        <el-alert type="warning" :closable="false" class="dialog__block">
          <template #title>
            用于「平台尝试发了但没成功」（账号不存在、户名不符、额度不足…）。
            与「驳回」<b>都解冻</b>，但成因不同 —— 分开登记才能看出问题出在收款信息还是审批口径。
            本次将解冻 <b>{{ fenToCny(current.amountFen) }}</b
            >。
          </template>
        </el-alert>
        <el-form label-width="86px">
          <el-form-item label="失败原因">
            <el-input
              v-model="failReason"
              type="textarea"
              :rows="3"
              maxlength="256"
              show-word-limit
              placeholder="必填，至少 2 个字（建议照抄平台回执原话）"
            />
          </el-form-item>
          <el-form-item label="出款批次">
            <el-input v-model="failBatchNo" placeholder="留空则沿用已登记批次" clearable />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="failVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="doMarkFailed">
          确认失败并解冻
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage } from 'element-plus';

import {
  approveWithdrawal,
  fetchAdminWithdrawals,
  markWithdrawalFailed,
  markWithdrawalPaid,
  rejectWithdrawal,
  type WithdrawRow,
  type WithdrawStatusValue,
  type WithdrawSummary,
  type WithdrawTabValue,
} from '@/api/finance';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny, formatDateTime, yuanToFen } from '@/utils/format';

const route = useRoute();

const loading = ref(false);
const submitting = ref(false);
const rows = ref<WithdrawRow[]>([]);
const total = ref(0);
const activeTab = ref<WithdrawTabValue>('review');
const statusOptions = ref<Array<{ value: string; label: string }>>([]);
/** 审批权在服务端判定（`@Roles(...FUND_ACTION_ROLES)`），此处仅用于渲染提示 */
const canAudit = ref(true);

const summary = reactive<WithdrawSummary>({
  asOf: '',
  pendingCount: 0,
  pendingAmountFen: 0,
  approvedCount: 0,
  approvedAmountFen: 0,
  payingCount: 0,
  payingAmountFen: 0,
  frozenByWithdrawFen: 0,
  paidCount: 0,
  paidAmountFen: 0,
  releasedCount: 0,
  releasedAmountFen: 0,
  scopedTotal: 0,
});

const query = reactive({
  status: '' as string,
  keyword: '',
  payoutBatchNo: '',
  page: 1,
  pageSize: 20,
});

const current = ref<WithdrawRow | null>(null);

const approveVisible = ref(false);
const approveBatchNo = ref('');
const approveRemark = ref('');

const rejectVisible = ref(false);
const rejectReason = ref('');

const paidVisible = ref(false);
/**
 * 代扣 / 实付两栏刻意用可空数值（而不是 `0`）——
 * `空` = 「我没填」，`0` = 「我填了 0」。后端按「是否传值」分三条分支，
 * 端上若把空输入当 0 传过去，就会把「系统假设无代扣」变成「运营确认无代扣」。
 *
 * ⚠️ 声明含 `undefined`：`el-input-number` 清空时 emit 的是 `undefined`（不是 `null`），
 *    只判 `=== null` 会漏掉清空后的状态。
 */
const paidTaxYuan = ref<number | null | undefined>(null);
const paidActualYuan = ref<number | null | undefined>(null);
const paidAt = ref('');
const paidBatchNo = ref('');
const paidRemark = ref('');

const failVisible = ref(false);
const failReason = ref('');
const failBatchNo = ref('');

/** el-table 插槽的 `row` 是宽松的 `DefaultRow`，在函数入口收窄一次 */
function asRow(raw: unknown): WithdrawRow {
  return raw as WithdrawRow;
}

function statusTagType(status: WithdrawStatusValue): 'info' | 'success' | 'warning' | 'danger' {
  if (status === 'success') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'rejected' || status === 'failed') return 'danger';
  return 'info';
}

// ---------------------------------------------------------------- 到账登记推导

const paidAmountFen = computed(() => current.value?.amountFen ?? 0);

/** 空（`null` / `undefined` / `NaN`）→ `null`（= 未填）；否则转整数分 */
function fenOrNull(v: number | null | undefined): number | null {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  return yuanToFen(v);
}

const paidTaxFen = computed(() => fenOrNull(paidTaxYuan.value));
const paidActualFen = computed(() => fenOrNull(paidActualYuan.value));

/**
 * 与 `WithdrawAdminService.markPaid()` **同一套推导规则**，用于提交前预告。
 *
 * 端上这份不是「第二份真相」—— 它只是把服务端的分支**提前展示**，
 * 真正的落账口径仍以服务端为准（服务端会再校验一次自洽性）。
 */
const paidHint = computed<{ type: 'info' | 'success' | 'warning' | 'error'; text: string }>(() => {
  const amount = paidAmountFen.value;
  const tax = paidTaxFen.value;
  const actual = paidActualFen.value;

  if (tax === null && actual === null) {
    return {
      type: 'warning',
      text:
        `两栏都未填 → 系统将按「无代扣」登记：实付 ${fenToCny(amount)}、代扣 ¥0.00。` +
        `若平台回执上确实扣了个税，请把金额填上再提交。`,
    };
  }
  if (actual === null) {
    const derived = amount - (tax ?? 0);
    if (derived < 0) {
      return { type: 'error', text: `代扣不能大于申请金额 ${fenToCny(amount)}。` };
    }
    return {
      type: 'info',
      text: `按「申请 − 代扣」推出实付 ${fenToCny(derived)}（代扣 ${fenToCny(tax)}）。`,
    };
  }
  if (tax === null) {
    const derived = amount - actual;
    if (derived < 0) {
      return { type: 'error', text: `实付不能大于申请金额 ${fenToCny(amount)}。` };
    }
    return {
      type: 'info',
      text: `按「申请 − 实付」推出代扣 ${fenToCny(derived)}（实付 ${fenToCny(actual)}）。`,
    };
  }
  if (amount - tax !== actual) {
    return {
      type: 'error',
      text:
        `代扣与实付不自洽：申请 ${fenToCny(amount)} − 代扣 ${fenToCny(tax)} ` +
        `≠ 实付 ${fenToCny(actual)}（差 ${fenToCny(amount - tax - actual)}）。请照回执核正。`,
    };
  }
  return {
    type: 'success',
    text: `自洽：申请 ${fenToCny(amount)} − 代扣 ${fenToCny(tax)} = 实付 ${fenToCny(actual)}。`,
  };
});

// ---------------------------------------------------------------- 数据加载

function onTabChange(): void {
  query.page = 1;
  reload();
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchAdminWithdrawals({
      tab: activeTab.value,
      status: (query.status || undefined) as WithdrawStatusValue | undefined,
      keyword: query.keyword.trim() || undefined,
      payoutBatchNo: query.payoutBatchNo.trim() || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list ?? [];
    total.value = res.total ?? 0;
    statusOptions.value = res.statusOptions ?? [];
    canAudit.value = res.actions?.canAudit ?? false;
    Object.assign(summary, res.summary);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '提现列表加载失败');
  } finally {
    loading.value = false;
  }
}

function failMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

// ---------------------------------------------------------------- 四动作

function openApprove(row: WithdrawRow): void {
  current.value = row;
  approveBatchNo.value = row.payoutBatchNo ?? '';
  approveRemark.value = '';
  approveVisible.value = true;
}

async function doApprove(): Promise<void> {
  if (!current.value) return;
  submitting.value = true;
  try {
    const res = await approveWithdrawal(current.value.id, {
      payoutBatchNo: approveBatchNo.value.trim() || undefined,
      remark: approveRemark.value.trim() || undefined,
    });
    approveVisible.value = false;
    ElMessage.success(`已批准（批次 ${res.payoutBatchNo}）；${res.nextStep}`);
    await reload();
  } catch (e) {
    // ⚠️ 不关弹窗：状态被并发改动（40017）时运营要能看清后重试
    ElMessage.error(failMsg(e, '批准失败'));
  } finally {
    submitting.value = false;
  }
}

function openReject(row: WithdrawRow): void {
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
    const res = await rejectWithdrawal(current.value.id, rejectReason.value.trim());
    rejectVisible.value = false;
    ElMessage.success(`已驳回并解冻；团长可用余额现为 ${fenToCny(res.balanceFen)}`);
    await reload();
  } catch (e) {
    ElMessage.error(failMsg(e, '驳回失败'));
  } finally {
    submitting.value = false;
  }
}

function openPaid(row: WithdrawRow): void {
  current.value = row;
  paidTaxYuan.value = null;
  paidActualYuan.value = null;
  paidAt.value = '';
  paidBatchNo.value = row.payoutBatchNo ?? '';
  paidRemark.value = '';
  paidVisible.value = true;
}

async function doMarkPaid(): Promise<void> {
  if (!current.value) return;
  if (paidHint.value.type === 'error') {
    ElMessage.warning(paidHint.value.text);
    return;
  }
  submitting.value = true;
  try {
    // 只把「填了的」栏传上去 —— 传 `0` 与不传在后端是两条不同分支
    const res = await markWithdrawalPaid(current.value.id, {
      taxWithheldFen: paidTaxFen.value ?? undefined,
      actualFen: paidActualFen.value ?? undefined,
      paidAt: paidAt.value || undefined,
      payoutBatchNo: paidBatchNo.value.trim() || undefined,
      remark: paidRemark.value.trim() || undefined,
    });
    paidVisible.value = false;
    const assumed = res.taxSource === 'assumed_zero' ? '（代扣按 ¥0 登记，未填代扣栏）' : '';
    ElMessage.success(`${res.tips}${assumed}`);
    await reload();
  } catch (e) {
    ElMessage.error(failMsg(e, '到账登记失败'));
  } finally {
    submitting.value = false;
  }
}

function openFail(row: WithdrawRow): void {
  current.value = row;
  failReason.value = '';
  failBatchNo.value = row.payoutBatchNo ?? '';
  failVisible.value = true;
}

async function doMarkFailed(): Promise<void> {
  if (!current.value) return;
  if (failReason.value.trim().length < 2) {
    ElMessage.warning('请填写失败原因（至少 2 个字）');
    return;
  }
  submitting.value = true;
  try {
    const res = await markWithdrawalFailed(current.value.id, {
      failReason: failReason.value.trim(),
      payoutBatchNo: failBatchNo.value.trim() || undefined,
    });
    failVisible.value = false;
    ElMessage.success(`已登记失败并解冻；团长可用余额现为 ${fenToCny(res.balanceFen)}`);
    await reload();
  } catch (e) {
    ElMessage.error(failMsg(e, '登记失败'));
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  // 从团长详情 / 余额页跳来时可能带 keyword（单号或团长姓名）：落地即筛到那一行
  const kw = String(route.query.keyword ?? '').trim();
  if (kw) query.keyword = kw;
  const tab = String(route.query.tab ?? '').trim() as WithdrawTabValue;
  if (['review', 'payout', 'done', 'all'].includes(tab)) activeTab.value = tab;
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
  margin-bottom: $space-3;

  &__group {
    flex: 1 1 420px;
    padding: $space-2 $space-3;
    background: $c-surface;
    border: 1px solid $c-border;
    border-radius: $radius-md;
  }

  &__caption {
    margin-bottom: $space-1;
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__row {
    display: flex;
    flex-wrap: wrap;
    gap: $space-4;
  }

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

.tag-inline {
  margin-right: $space-1;
}

.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: $fs-caption;
}

.muted {
  color: $c-text-weak;
}

.sub {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.ml-sm {
  margin-left: $space-1;
}

.amount {
  font-weight: 700;
  color: $c-warn-fg;
}

.num {
  width: 150px;
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
}
</style>
