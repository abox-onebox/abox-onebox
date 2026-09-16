<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  adjustFinanceBalance,
  fetchFinanceBalances,
  type AdjustBalanceResult,
  type BalanceAccountRow,
  type BalanceAdjustAction,
  type BalanceLiability,
  type BalanceLogRow,
} from '@/api/finance';

/**
 * P34 余额账户管理与调整（D38 · D39 · M3-14 · 模块 M35-04）
 *
 * ## 三个刻意的设计
 * 1. ⭐ **顶部负债是「全量 · 时点量」，不随下方筛选变化** —— 「平台还欠用户多少钱」
 *    不该因为运营在搜索框敲了个昵称就变小。它与 D33 资金总览的 `liability`
 *    取自**同一个服务函数**，两页数字必然相等；而下方的「命中 N 个账户」才是筛选结果。
 * 2. **手机号一律脱敏**（同 M3-6 纪律）：余额页不是查人资料的地方。
 * 3. **调账必须填原因 + 走幂等键**：原因会写进余额流水（日后唯一能回答
 *    「运营为什么给这个人加钱」的信息）；幂等键保证「网络超时后重试」不会加两次钱。
 *
 * ⚠️ 端上不做金额口径计算：余额 / 冻结 / 累计进出全部取服务端（整数分），
 *    端上只做 `÷100` 的展示换算。唯一的端上换算是**输入方向**（元 → 分，见提交处）。
 */

const ADJUST_ACTIONS = [
  { value: 'recharge', label: '充值', hint: '平台给用户加钱（活动返现 / 客服补偿）' },
  { value: 'deduct', label: '扣减', hint: '从可用余额扣掉（不可使余额为负）' },
  { value: 'freeze', label: '冻结', hint: '可用 → 冻结：钱还是他的，只是暂时不可用' },
  { value: 'unfreeze', label: '解冻', hint: '冻结 → 可用' },
];

const loading = ref(false);
const accountType = ref('all');
const keyword = ref('');
const userIdInput = ref<number | undefined>(undefined);

const rows = ref<BalanceAccountRow[]>([]);
const liability = ref<BalanceLiability | null>(null);
const logs = ref<BalanceLogRow[]>([]);
const view = ref<'list' | 'single'>('list');
const canAdjust = ref(false);
const accountTypeOptions = ref<Array<{ value: string; label: string }>>([]);
const page = ref(1);
const pageSize = ref(20);
const total = ref(0);

/** 调账弹窗 */
const dialogVisible = ref(false);
const submitting = ref(false);
const target = ref<BalanceAccountRow | null>(null);
const form = ref<{ action: string; amountYuan: number; reason: string }>({
  action: 'recharge',
  amountYuan: 0,
  reason: '',
});
/**
 * 幂等键（**必填** · 服务端 `10001` 拒空）
 *
 * 语义 = 「**这一笔调整**」：弹窗打开时生成一次，**提交失败重试沿用同一个**
 * （服务端返回首次结果而不是再扣一次）；成功后重置，下次调整是新的一笔。
 */
const idemKey = ref('');

const money = (fen?: number | null) => `¥${((fen ?? 0) / 100).toFixed(2)}`;
/** 输入框里现在是「元」，实时给出「分」—— 让运营知道落库口径是分 */
const amountFenPreview = computed(() => Math.round(Number(form.value.amountYuan || 0) * 100));

const currentAction = computed(() => ADJUST_ACTIONS.find((a) => a.value === form.value.action));

/** 目标用户无账户时，只有「充值」可执行（服务端会自动建户） */
const actionDisabled = (value: string) => !target.value?.hasAccount && value !== 'recharge';

function newIdemKey(): string {
  const c = globalThis.crypto as Crypto | undefined;
  return c && typeof c.randomUUID === 'function'
    ? c.randomUUID()
    : `adj-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** el-table 的插槽 `row` 是 `DefaultRow`，显式收敛回业务行类型（同 `leader/list.vue`） */
const asRow = (row: unknown) => row as BalanceAccountRow;

async function load() {
  loading.value = true;
  try {
    const res = await fetchFinanceBalances({
      accountType: accountType.value === 'all' ? undefined : accountType.value,
      keyword: keyword.value.trim() || undefined,
      userId: userIdInput.value || undefined,
      page: page.value,
      pageSize: pageSize.value,
    });
    rows.value = res.list ?? [];
    liability.value = res.liability ?? null;
    logs.value = res.logs ?? [];
    view.value = res.view ?? 'list';
    canAdjust.value = Boolean(res.actions?.canAdjust);
    accountTypeOptions.value = res.accountTypeOptions ?? [];
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

/** 退出「单用户」模式（清掉精确查询条件） */
async function backToList() {
  userIdInput.value = undefined;
  await reload();
}

function openAdjust(row: BalanceAccountRow) {
  target.value = row;
  // 默认落在「充值」（无账户用户唯一可行的动作，有账户时也是最常用的一项）
  form.value = { action: 'recharge', amountYuan: 0, reason: '' };
  idemKey.value = newIdemKey();
  dialogVisible.value = true;
}

async function submitAdjust() {
  const t = target.value;
  if (!t) return;

  const amountFen = Math.round(Number(form.value.amountYuan || 0) * 100);
  if (!Number.isInteger(amountFen) || amountFen <= 0) {
    ElMessage.warning('请输入大于 0 的金额');
    return;
  }
  if (form.value.reason.trim().length < 2) {
    ElMessage.warning('请填写调整原因（至少 2 个字）—— 这是日后唯一能回答「为什么动这笔钱」的信息');
    return;
  }
  if (!t.hasAccount && form.value.action !== 'recharge') {
    ElMessage.warning('该用户尚无余额账户，只有「充值」可以执行（会自动建户）');
    return;
  }

  const actionLabel = currentAction.value?.label ?? form.value.action;
  const who = t.nickname || `用户 #${t.userId}`;

  try {
    await ElMessageBox.confirm(
      `将对「${who}」执行【${actionLabel}】${money(amountFen)}。\n\n` +
        `· 当前可用 ${money(t.balanceFen)} · 冻结 ${money(t.frozenFen)}\n` +
        `· 原因将写入余额流水，用户在自己的余额明细里可见\n` +
        `· 已带幂等键：网络异常重试不会重复执行`,
      '确认调整余额',
      { confirmButtonText: '确认执行', cancelButtonText: '取消', type: 'warning' },
    );
  } catch {
    return; // 用户取消
  }

  submitting.value = true;
  try {
    const res: AdjustBalanceResult = await adjustFinanceBalance(
      {
        userId: t.userId,
        action: form.value.action as BalanceAdjustAction,
        amountFen,
        reason: form.value.reason.trim(),
      },
      idemKey.value,
    );

    await ElMessageBox.alert(
      [
        `调整单号：${res.adjustNo}`,
        `动作：${res.actionText} ${money(res.amountFen)}`,
        `可用余额：${money(res.balanceBeforeFen)} → ${money(res.balanceFen)}`,
        `冻结金额：${money(res.frozenBeforeFen)} → ${money(res.frozenFen)}`,
        `负债合计：${money(res.netFen)}`,
        '',
        `原因：${res.reason}`,
        `操作人：${res.operatorName}（#${res.operatorId}）`,
        '',
        '冻结 / 解冻不改动「累计进出」—— 钱没进出平台，只是从「可用」挪到「冻结」。',
      ].join('\n'),
      '余额调整成功',
      { confirmButtonText: '知道了', customStyle: { whiteSpace: 'pre-line', maxWidth: '520px' } },
    );

    dialogVisible.value = false;
    idemKey.value = ''; // 成功后作废：下一次调整是新的一笔
    await load();
  } catch (e) {
    // ⚠️ 刻意**不重置** idemKey：失败后重试应复用同一键（同一次调整）
    ElMessage.error((e as Error).message || '调整失败');
  } finally {
    submitting.value = false;
  }
}

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="page-container">
    <h2 class="page-container__title">余额账户管理与调整</h2>
    <p class="page-container__meta">
      原型页 / 模块：P34 · M35-04 ｜ 真源 = <code>ab_balance</code>（快照）+
      <code>ab_balance_log</code>（发生额账本）·
      用户与团长<strong>共用同一余额池</strong>（同一小程序身份）
    </p>

    <!-- 全量负债：时点量，与 D33 资金总览同源 -->
    <div class="liab">
      <div class="liab__item">
        <span class="liab__label">平台可用余额负债</span>
        <span class="liab__value">{{ money(liability?.balanceFen) }}</span>
      </div>
      <div class="liab__item">
        <span class="liab__label">冻结金额</span>
        <span class="liab__value warn">{{ money(liability?.frozenFen) }}</span>
      </div>
      <div class="liab__item">
        <span class="liab__label">负债合计</span>
        <span class="liab__value">{{ money(liability?.netFen) }}</span>
      </div>
      <div class="liab__item">
        <span class="liab__label">账户数</span>
        <span class="liab__value">{{ liability?.accountCount ?? 0 }}</span>
        <span class="liab__hint">其中团长 {{ liability?.leaderAccountCount ?? 0 }} 个</span>
      </div>
      <div class="liab__asof">
        <div>截至 {{ liability?.asOf || '—' }}</div>
        <div class="liab__note">
          时点量 · <strong>全量</strong>，不随下方筛选变化（与 D33 资金总览同一口径）
        </div>
      </div>
    </div>

    <el-card shadow="never" class="bar">
      <div class="toolbar">
        <el-radio-group v-model="accountType" @change="reload">
          <el-radio-button
            v-for="opt in accountTypeOptions.length
              ? accountTypeOptions
              : [{ value: 'all', label: '全部账户' }]"
            :key="opt.value"
            :label="opt.value"
          >
            {{ opt.label }}
          </el-radio-button>
        </el-radio-group>
        <el-input
          v-model="keyword"
          class="kw"
          clearable
          placeholder="昵称 / 手机号"
          @keyup.enter="reload"
          @clear="reload"
        />
        <el-input-number
          v-model="userIdInput"
          class="uid"
          :min="1"
          :controls="false"
          placeholder="用户 ID 精确查"
        />
        <div class="toolbar__right">
          <el-button v-if="view === 'single'" @click="backToList">返回列表</el-button>
          <el-button :loading="loading" @click="reload">查询</el-button>
        </div>
      </div>
    </el-card>

    <!-- 精确查：账户卡 + 最近流水 -->
    <template v-if="view === 'single' && rows.length">
      <el-card shadow="never" class="acct">
        <template #header>
          <div class="acct__head">
            <span>
              {{ rows[0].nickname || '（无昵称）' }}
              <span class="uid-tag">#{{ rows[0].userId }}</span>
              <el-tag v-if="rows[0].isLeader" size="small" class="ml">
                团长 · {{ rows[0].leaderLevelText }}（{{ rows[0].leaderStatusText }}）
              </el-tag>
              <el-tag v-else size="small" type="info" class="ml">普通用户</el-tag>
              <el-tag v-if="!rows[0].hasAccount" size="small" type="warning" class="ml">
                尚无账户 —— 仅「充值」可执行，会自动建户
              </el-tag>
            </span>
            <el-button v-if="canAdjust" type="primary" size="small" @click="openAdjust(rows[0])">
              调整余额
            </el-button>
          </div>
        </template>
        <div class="acct__grid">
          <div>
            <span>可用余额</span><strong>{{ money(rows[0].balanceFen) }}</strong>
          </div>
          <div>
            <span>冻结</span><strong>{{ money(rows[0].frozenFen) }}</strong>
          </div>
          <div>
            <span>合计</span><strong>{{ money(rows[0].netFen) }}</strong>
          </div>
          <div>
            <span>累计收入</span><strong>{{ money(rows[0].totalInFen) }}</strong>
          </div>
          <div>
            <span>累计支出</span><strong>{{ money(rows[0].totalOutFen) }}</strong>
          </div>
          <div>
            <span>手机号（脱敏）</span><strong>{{ rows[0].phoneMasked || '—' }}</strong>
          </div>
        </div>
      </el-card>

      <el-card v-loading="loading" shadow="never" class="logs">
        <template #header
          >最近 20 条余额流水（含佣金 / 抵扣 / 提现 / 退款回退 / 管理端调整）</template
        >
        <el-table v-if="logs.length" :data="logs" size="small" stripe>
          <el-table-column prop="createdAt" label="时间" min-width="165" />
          <el-table-column label="类型" width="110">
            <template #default="{ row }">{{ row.typeText }}</template>
          </el-table-column>
          <el-table-column label="金额" width="120" align="right">
            <template #default="{ row }">
              <span :class="row.direction > 0 ? 'in' : 'out'">
                {{ row.direction > 0 ? '+' : '-' }}{{ money(row.amountFen) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="操作后余额" width="120" align="right">
            <template #default="{ row }">{{ money(row.balanceAfterFen) }}</template>
          </el-table-column>
          <el-table-column prop="relatedId" label="关联单号" min-width="160" />
          <el-table-column prop="remark" label="备注" min-width="260" />
        </el-table>
        <el-empty v-else description="该账户还没有流水" />
      </el-card>
    </template>

    <!-- 列表 -->
    <el-card v-else v-loading="loading" shadow="never">
      <el-table v-if="rows.length" :data="rows" size="small" stripe>
        <el-table-column label="用户" min-width="180">
          <template #default="{ row }">
            <div>{{ row.nickname || '（无昵称）' }}</div>
            <div class="sub">#{{ row.userId }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="phoneMasked" label="手机号（脱敏）" width="130" />
        <el-table-column label="身份" width="150">
          <template #default="{ row }">
            <el-tag v-if="row.isLeader" size="small">
              {{ row.leaderLevelText }} · {{ row.leaderStatusText }}
            </el-tag>
            <span v-else class="sub">普通用户</span>
          </template>
        </el-table-column>
        <el-table-column label="可用余额" width="120" align="right">
          <template #default="{ row }">
            <strong>{{ money(row.balanceFen) }}</strong>
          </template>
        </el-table-column>
        <el-table-column label="冻结" width="110" align="right">
          <template #default="{ row }">
            <span :class="{ warn: row.frozenFen > 0 }">{{ money(row.frozenFen) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="合计" width="110" align="right">
          <template #default="{ row }">{{ money(row.netFen) }}</template>
        </el-table-column>
        <el-table-column label="累计收入" width="110" align="right">
          <template #default="{ row }">{{ money(row.totalInFen) }}</template>
        </el-table-column>
        <el-table-column label="累计支出" width="110" align="right">
          <template #default="{ row }">{{ money(row.totalOutFen) }}</template>
        </el-table-column>
        <el-table-column label="更新时间" min-width="165">
          <template #default="{ row }">
            {{ row.updatedAt ? row.updatedAt.replace('T', ' ').slice(0, 19) : '—' }}
          </template>
        </el-table-column>
        <el-table-column v-if="canAdjust" label="操作" width="110" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openAdjust(asRow(row))">调整</el-button>
          </template>
        </el-table-column>
      </el-table>
      <el-empty v-else description="没有符合条件的余额账户" />

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

    <!-- 调账弹窗 -->
    <el-dialog v-model="dialogVisible" title="调整余额（资金动作）" width="520px">
      <div v-if="target" class="dlg-target">
        <div>
          目标：<strong>{{ target.nickname || '（无昵称）' }}</strong>
          <span class="uid-tag">#{{ target.userId }}</span>
          <el-tag v-if="target.isLeader" size="small" class="ml">
            {{ target.leaderLevelText }}
          </el-tag>
        </div>
        <div class="sub">
          当前可用 {{ money(target.balanceFen) }} · 冻结 {{ money(target.frozenFen) }}
        </div>
        <el-alert
          v-if="!target.hasAccount"
          type="warning"
          :closable="false"
          show-icon
          title="该用户尚无余额账户（从未发生资金往来）"
          description="只有「充值」可执行 —— 服务端会自动为其建户。其余动作需要已有余额作前提。"
        />
      </div>

      <el-form label-width="86px" class="dlg-form">
        <el-form-item label="动作">
          <el-radio-group v-model="form.action">
            <el-radio-button
              v-for="a in ADJUST_ACTIONS"
              :key="a.value"
              :label="a.value"
              :disabled="actionDisabled(a.value)"
            >
              {{ a.label }}
            </el-radio-button>
          </el-radio-group>
          <div class="sub hint">{{ currentAction?.hint }}</div>
        </el-form-item>

        <el-form-item label="金额">
          <el-input-number
            v-model="form.amountYuan"
            :min="0"
            :precision="2"
            :step="10"
            class="amount"
          />
          <span class="sub ml-sm">元 ＝ {{ amountFenPreview }} 分（落库口径）</span>
        </el-form-item>

        <el-form-item label="原因">
          <el-input
            v-model="form.reason"
            type="textarea"
            :rows="2"
            maxlength="128"
            show-word-limit
            placeholder="必填 · 例：客服补偿：9-15 配送超时"
          />
          <div class="sub hint">写入余额流水，用户在自己的余额明细里可见</div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="submitAdjust"> 确认调整 </el-button>
      </template>
    </el-dialog>

    <p class="note">
      口径提示：<strong>冻结 / 解冻不改动「累计收入 / 累计支出」</strong> —— 钱没有进出平台，
      只是在「可用」与「冻结」之间移动（与团长提现「申请阶段不计入累计支出」同一处理）。
      调账必带<strong>幂等键</strong>：网络超时后重试不会重复加减；扣减 / 冻结超出可用额会被服务端
      拒绝（余额不可为负），解冻超出冻结额同样拒绝。
    </p>
  </div>
</template>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-4;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.liab {
  display: flex;
  flex-wrap: wrap;
  gap: $space-4;
  align-items: center;
  padding: $space-3;
  margin-bottom: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__item {
    display: flex;
    flex-direction: column;
    min-width: 160px;
  }

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    font-size: 20px;
    font-weight: 700;

    &.warn {
      color: var(--el-color-warning);
    }
  }

  &__hint {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__asof {
    margin-left: auto;
    color: $c-text-weak;
    font-size: $fs-caption;
    text-align: right;
  }

  &__note {
    margin-top: 2px;
  }
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
    width: 190px;
  }

  .uid {
    width: 150px;
  }

  &__right {
    display: flex;
    gap: $space-2;
    margin-left: auto;
  }
}

.acct {
  margin-bottom: $space-3;

  &__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__grid {
    display: flex;
    flex-wrap: wrap;
    gap: $space-4;

    > div {
      display: flex;
      flex-direction: column;
      min-width: 130px;

      > span {
        color: $c-text-weak;
        font-size: $fs-caption;
      }

      > strong {
        font-size: 16px;
      }
    }
  }
}

.logs {
  margin-bottom: $space-3;
}

.dlg-target {
  padding: $space-2 $space-3;
  margin-bottom: $space-3;
  background: $c-surface;
  border-radius: $radius-sm;

  .el-alert {
    margin-top: $space-2;
  }
}

.dlg-form {
  .amount {
    width: 180px;
  }

  .hint {
    margin-top: 2px;
  }
}

.uid-tag {
  margin-left: 6px;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.sub {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.ml {
  margin-left: 8px;
}

.ml-sm {
  margin-left: 8px;
}

.warn {
  color: var(--el-color-warning);
}

.in {
  color: var(--el-color-success);
}

.out {
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
</style>
