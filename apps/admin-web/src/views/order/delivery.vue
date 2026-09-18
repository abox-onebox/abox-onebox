<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';

import {
  advanceDeliveryStatus,
  fetchDeliveries,
  patchDelivery,
  type DeliveryAdvanceResult,
  type DeliveryListResult,
  type DeliveryPatchBody,
  type DeliveryRow,
} from '@/api/delivery';

/**
 * 配送单管理（运营后台 · M5-1 · D61 查看 / D62 人工修正 · M5-8 · D63 状态推进）
 *
 * 收口挂账 #61：跑批对已存在的配送单**跳过不覆盖**（保护人工录入的司机 / 车牌），
 * 代价是份数也被一起冻住 —— 在此之前**没有任何页面能改**，口子只在 DBA 手里。
 *
 * ⭐ M5-8 补 D63：在此之前**配送状态也推进不了**（只有接口、没有入口），
 *    而「发车 / 送达」正是订单 `cooked → delivering → delivered` 的**唯一驱动** ——
 *    订单于是永远停在 `cut_off`、佣金永不产生、且**不报任何错**（《缺陷与陷阱》#79）。
 *    本页的「推进」按钮就是那条链在**运营手上**的入口。
 *
 * ⚠️ 份数与订单不符 **不等于「被人改过」**：也可能是截单后订单侧退款 / 取消，
 *    而配送单份数在截单时已定格、不会跟着降。本页不区分这两者（系统也无法），
 *    只如实标出差异并给出排查入口（操作日志 `module=delivery`）。口径说明
 *    由服务端随出参下发（`note`），端上原样展示、不复制第二份文案。
 */
const loading = ref(false);
const saving = ref(false);
const date = ref('');
const status = ref('');
const data = ref<DeliveryListResult | null>(null);

const rows = computed<DeliveryRow[]>(() => data.value?.list ?? []);
const statusOptions = computed(() => data.value?.statusOptions ?? []);

/**
 * 履约流顺序与中文名 —— **全部取自服务端下发的 `statusOptions`**
 *
 * ⚠️ 端上刻意**不写第二份** `['pending','called','en_route','arrived']`：
 *    顺序与文案各写一份就会各错各的（同族 #15 / #63 / #67 / #76），
 *    而 `statusOptions` 正是服务端按 `DELIVERY_STATUS_ORDER` 生成的那一份。
 */
const labelOf = (v: string) => statusOptions.value.find((o) => o.value === v)?.label ?? v;

function nextOf(cur: string): string | null {
  const order = statusOptions.value.map((o) => o.value);
  const i = order.indexOf(cur);
  return i >= 0 && i < order.length - 1 ? order[i + 1] : null;
}

async function load() {
  loading.value = true;
  try {
    const r = await fetchDeliveries({
      date: date.value || undefined,
      status: status.value || undefined,
    });
    data.value = r;
    // 服务端 `date` 缺省时自行推导了「最近有单的出餐日」—— 回填选择器，让端上与之一致
    if (r.date) date.value = r.date;
  } catch (e) {
    ElMessage.error((e as Error).message || '加载失败');
  } finally {
    loading.value = false;
  }
}

// ---------------------------------------------------------------- 修正弹窗
const dialogVisible = ref(false);
const editing = ref<DeliveryRow | null>(null);
const form = reactive({
  totalQuantity: 0,
  driverName: '',
  driverPhone: '',
  plateNo: '',
  remark: '',
  reason: '',
});

/** 文本归一：与服务端同一规则（空串 = 清空该字段 → null） */
const norm = (v: string) => (v.trim() === '' ? null : v.trim());

/** 变更预览 —— 只列**真正变了**的字段（与服务端 `changed` 判定同规则） */
const diffs = computed<Array<{ label: string; from: string; to: string }>>(() => {
  const row = editing.value;
  if (!row) return [];
  const out: Array<{ label: string; from: string; to: string }> = [];
  const show = (v: string | number | null) => (v === null || v === '' ? '（空）' : String(v));

  if (form.totalQuantity !== row.totalQuantity) {
    out.push({ label: '份数', from: show(row.totalQuantity), to: show(form.totalQuantity) });
  }
  const texts: Array<[string, string, string | null, string]> = [
    ['司机', 'driverName', row.driverName, form.driverName],
    ['司机电话', 'driverPhone', row.driverPhone, form.driverPhone],
    ['车牌', 'plateNo', row.plateNo, form.plateNo],
    ['备注', 'remark', row.remark, form.remark],
  ];
  for (const [label, , from, to] of texts) {
    if (norm(from ?? '') !== norm(to)) out.push({ label, from: show(from), to: show(norm(to)) });
  }
  return out;
});

const reasonOk = computed(() => form.reason.trim().length >= 2);

function openEdit(row: DeliveryRow) {
  editing.value = row;
  form.totalQuantity = row.totalQuantity;
  form.driverName = row.driverName ?? '';
  form.driverPhone = row.driverPhone ?? '';
  form.plateNo = row.plateNo ?? '';
  form.remark = row.remark ?? '';
  form.reason = '';
  dialogVisible.value = true;
}

async function submit() {
  const row = editing.value;
  if (!row || !diffs.value.length || !reasonOk.value) return;

  // ⚠️ 只提交**真正变了**的字段：提交未改的字段会进服务端 `unchanged[]`，
  //    虽然不会写库，但会让操作日志里多一堆无意义的字段噪音。
  const body: DeliveryPatchBody = { version: row.version, reason: form.reason.trim() };
  for (const d of diffs.value) {
    if (d.label === '份数') body.totalQuantity = form.totalQuantity;
    if (d.label === '司机') body.driverName = form.driverName;
    if (d.label === '司机电话') body.driverPhone = form.driverPhone;
    if (d.label === '车牌') body.plateNo = form.plateNo;
    if (d.label === '备注') body.remark = form.remark;
  }

  saving.value = true;
  try {
    const r = await patchDelivery(row.id, body);
    ElMessage.success(`已修正 ${r.changed.length} 项（版本 → ${r.version}）`);
    dialogVisible.value = false;
    await load();
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err.code === 30016) {
      // 乐观锁冲突：别人刚改过这张单。刷新拿最新值后重提 —— 不覆盖他人的修改。
      ElMessage.warning(err.message || '这张配送单已被他人修改，已刷新为最新值');
      dialogVisible.value = false;
      await load();
    } else {
      ElMessage.error(err.message || '修正失败');
    }
  } finally {
    saving.value = false;
  }
}

// -------------------------------------------------------- 推进履约（D63）
const advVisible = ref(false);
const advancing = ref(false);
const advRow = ref<DeliveryRow | null>(null);
const advTo = ref('');
const advNote = ref('');

/**
 * 该行有没有订单「没跟上」
 *
 * ⭐ `cut_off` 的订单意味着**上游出餐还没确认**（T7 没发生）—— 此时即使把配送单推到
 *    「已送达」，订单也不会动（T9 的条件更新是 `delivering → delivered`）。
 *    把它在行内标出来，运营就不会把「推了没反应」当成系统坏了。
 */
const laggingOf = (row: DeliveryRow) =>
  (row.orderStatusBreakdown ?? []).find((b) => b.status === 'cut_off');

function openAdvance(row: DeliveryRow) {
  const to = nextOf(row.status);
  if (!to) return;
  advRow.value = row;
  advTo.value = to;
  advNote.value = '';
  advVisible.value = true;
}

async function submitAdvance() {
  const row = advRow.value;
  if (!row || !advTo.value) return;
  advancing.value = true;
  try {
    const r = await advanceDeliveryStatus(row.id, {
      to: advTo.value,
      version: row.version,
      ...(advNote.value.trim() ? { note: advNote.value.trim() } : {}),
    });
    advVisible.value = false;
    await load();
    ElMessage.success(describeAdvance(r));
    // ⚠️「推进了但订单没跟上」必须**单独警示**：只在成功提示里带一句会被忽略，
    //    而它正是 #79 的形状（链子断了却不报错）。
    if (r.orderTransition && r.orderTransition.advanced === 0) {
      ElMessage.warning(r.orderTransition.note || '配送单已推进，但订单状态没有跟着动');
    }
  } catch (e) {
    const err = e as { code?: number; message?: string };
    if (err.code === 30016) {
      ElMessage.warning(err.message || '这张配送单已被他人修改，已刷新为最新值');
      advVisible.value = false;
      await load();
    } else {
      ElMessage.error(err.message || '推进失败');
    }
  } finally {
    advancing.value = false;
  }
}

/** 成功提示：把「配送单 → X」与「订单联动了几单」写进**同一句话** */
function describeAdvance(r: DeliveryAdvanceResult): string {
  const head = `配送单 ${r.fromText} → ${r.toText}`;
  const t = r.orderTransition;
  if (!t) return `${head}（本步不联动订单）`;
  return t.advanced > 0
    ? `${head}；联动订单 ${t.advanced} 单（${t.fromText} → ${t.toText}）`
    : `${head}；订单未联动（${t.note ?? '无符合条件的订单'}）`;
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="page">
    <el-card shadow="never">
      <div class="head">
        <div>
          <h3>配送单管理</h3>
          <p class="sub">按楼群查看当日配送单，可人工修正份数 / 司机 / 车牌</p>
        </div>
        <div class="ops">
          <el-date-picker
            v-model="date"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="出餐日"
            clearable
            @change="load"
          />
          <el-select
            v-model="status"
            placeholder="全部状态"
            clearable
            style="width: 130px"
            @change="load"
          >
            <el-option
              v-for="o in statusOptions"
              :key="o.value"
              :label="o.label"
              :value="o.value"
            />
          </el-select>
          <el-button @click="load">刷新</el-button>
        </div>
      </div>

      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="note"
        title="份数与订单不符有两种成因，本页不区分"
        :description="data?.note ?? ''"
      />

      <div class="stats">
        <div class="stat">
          <div class="stat__v">{{ data?.summary.count ?? 0 }}</div>
          <div class="stat__l">配送单</div>
        </div>
        <div class="stat">
          <div class="stat__v">{{ data?.summary.totalQuantity ?? 0 }}</div>
          <div class="stat__l">配送份数</div>
        </div>
        <div class="stat">
          <div class="stat__v">{{ data?.summary.totalOrderQuantity ?? 0 }}</div>
          <div class="stat__l">订单份数</div>
        </div>
        <div class="stat">
          <div class="stat__v" :class="{ 'stat__v--warn': (data?.summary.mismatchCount ?? 0) > 0 }">
            {{ data?.summary.mismatchCount ?? 0 }}
          </div>
          <div class="stat__l">份数不符</div>
        </div>
        <div class="stat">
          <div class="stat__v">{{ data?.summary.manualInputCount ?? 0 }}</div>
          <div class="stat__l">已录司机</div>
        </div>
      </div>
    </el-card>

    <el-empty v-if="!loading && !rows.length" :description="data?.reason ?? '该出餐日没有配送单'" />

    <el-card v-else shadow="never" class="table-card">
      <el-table :data="rows" size="small" border>
        <el-table-column label="楼群" min-width="150">
          <template #default="{ row }">{{
            row.buildingGroupName ?? `#${row.buildingGroupId}`
          }}</template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">{{ row.statusText }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="配送 / 订单" width="110" align="center">
          <template #default="{ row }">
            <span :class="{ qty__v: true, 'qty__v--bad': row.quantityMismatch }">
              {{ row.totalQuantity }} / {{ row.orderQuantity }}
            </span>
            <div v-if="row.quantityMismatch" class="qty__d">
              差 {{ row.quantityDiff > 0 ? '+' : '' }}{{ row.quantityDiff }}
            </div>
          </template>
        </el-table-column>
        <el-table-column label="司机" min-width="110">
          <template #default="{ row }">
            <span v-if="row.driverName">{{ row.driverName }}</span>
            <span v-else class="muted">未录入</span>
          </template>
        </el-table-column>
        <el-table-column label="司机电话" width="130">
          <template #default="{ row }">
            <span v-if="row.driverPhone">{{ row.driverPhone }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="车牌" width="110">
          <template #default="{ row }">
            <span v-if="row.plateNo">{{ row.plateNo }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="预计送达" width="150">
          <template #default="{ row }">{{ row.expectedAt ?? '—' }}</template>
        </el-table-column>
        <el-table-column label="备注" min-width="120">
          <template #default="{ row }">
            <span v-if="row.remark">{{ row.remark }}</span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="订单进度" min-width="170">
          <template #default="{ row }">
            <template v-if="(row as DeliveryRow).orderStatusBreakdown?.length">
              <span
                v-for="b in (row as DeliveryRow).orderStatusBreakdown"
                :key="b.status"
                class="bd"
                :class="{ 'bd--warn': b.status === 'cut_off' }"
              >
                {{ b.statusText }} {{ b.orderCount }}
              </span>
            </template>
            <span v-else class="muted">无订单</span>
            <div v-if="laggingOf(row as DeliveryRow)" class="bd__warn">
              有订单还停在「已截单」—— 出餐未确认，推进履约不会带着它走
            </div>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="150" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" @click="openEdit(row as DeliveryRow)">修正</el-button>
            <el-tooltip
              :disabled="!!nextOf((row as DeliveryRow).status)"
              content="已是终态（已送达），履约流到此为止"
              placement="top"
            >
              <span>
                <el-button
                  link
                  type="success"
                  :disabled="!nextOf((row as DeliveryRow).status)"
                  @click="openAdvance(row as DeliveryRow)"
                >
                  推进到{{ labelOf(nextOf((row as DeliveryRow).status) ?? '') || '—' }}
                </el-button>
              </span>
            </el-tooltip>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- 修正弹窗：提交前展示 before → after，避免「点了保存不知道改了什么」 -->
    <el-dialog v-model="dialogVisible" title="人工修正配送单" width="560px">
      <div v-if="editing" class="dlg">
        <p class="sub">
          {{ editing.buildingGroupName ?? `楼群 #${editing.buildingGroupId}` }} · 出餐日
          {{ editing.mealDate }} · 当前版本 v{{ editing.version }}
        </p>

        <el-form label-width="90px" class="form">
          <el-form-item label="配送份数">
            <el-input-number v-model="form.totalQuantity" :min="0" :max="9999" />
            <span class="sub hint">按订单算出的份数是 {{ editing.orderQuantity }}</span>
          </el-form-item>
          <el-form-item label="司机">
            <el-input v-model="form.driverName" maxlength="64" placeholder="留空表示不填" />
          </el-form-item>
          <el-form-item label="司机电话">
            <el-input v-model="form.driverPhone" maxlength="20" placeholder="留空表示不填" />
          </el-form-item>
          <el-form-item label="车牌">
            <el-input v-model="form.plateNo" maxlength="16" placeholder="留空表示不填" />
          </el-form-item>
          <el-form-item label="备注">
            <el-input
              v-model="form.remark"
              type="textarea"
              :rows="2"
              maxlength="256"
              show-word-limit
            />
          </el-form-item>
          <el-form-item label="修正原因" required>
            <el-input
              v-model="form.reason"
              maxlength="64"
              placeholder="至少 2 个字，会写入操作日志"
            />
          </el-form-item>
        </el-form>

        <div class="diff">
          <div class="diff__t">本次变更</div>
          <el-empty v-if="!diffs.length" description="没有任何字段发生变化" :image-size="48" />
          <ul v-else class="diff__list">
            <li v-for="d in diffs" :key="d.label">
              <span class="diff__k">{{ d.label }}</span>
              <span class="diff__from">{{ d.from }}</span>
              <span class="diff__arrow">→</span>
              <span class="diff__to">{{ d.to }}</span>
            </li>
          </ul>
        </div>
      </div>

      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="!diffs.length || !reasonOk"
          @click="submit"
        >
          提交修正
        </el-button>
      </template>
    </el-dialog>

    <!-- 推进履约弹窗（D63）：确认目标态 + 可选补充说明。
         ⚠️ 只给「紧邻下一态」——跳级会跳过 T8（订单联动），服务端也会以 30018 拒绝。 -->
    <el-dialog v-model="advVisible" title="推进配送状态" width="520px">
      <div v-if="advRow" class="dlg">
        <p class="sub">
          {{ advRow.buildingGroupName ?? `楼群 #${advRow.buildingGroupId}` }} · 出餐日
          {{ advRow.mealDate }} · 当前版本 v{{ advRow.version }}
        </p>

        <div class="adv">
          <span class="adv__from">{{ advRow.statusText }}</span>
          <span class="adv__arrow">→</span>
          <span class="adv__to">{{ labelOf(advTo) }}</span>
        </div>

        <p class="sub adv__hint">
          推进后：<b>配送单</b>状态随之变化，并<template v-if="advTo === 'en_route'">
            联动该楼群订单 <b>已出餐 → 配送中</b>（状态机 T8）</template
          ><template v-else-if="advTo === 'arrived'">
            联动该楼群订单 <b>配送中 → 已送达</b>（状态机 T9），订单「送达」之后
            佣金链路才可达</template
          ><template v-else>
            本步<b>不动订单</b>（货还在加工场所，订单要到「配送中」才该动）</template
          >。
        </p>

        <el-alert
          v-if="laggingOf(advRow)"
          type="warning"
          show-icon
          :closable="false"
          title="本楼群有订单还停在「已截单」"
          description="那些订单不会跟着动（上游出餐未确认）。请先让供应商完成出餐确认，否则这部分订单会一直卡住、佣金也不会产生。"
        />

        <el-form label-width="90px" class="form">
          <el-form-item label="补充说明">
            <el-input
              v-model="advNote"
              maxlength="64"
              placeholder="可选，如「堵车晚点 20 分钟」，会写入操作日志"
            />
          </el-form-item>
        </el-form>
      </div>

      <template #footer>
        <el-button @click="advVisible = false">取消</el-button>
        <el-button type="success" :loading="advancing" @click="submitAdvance">
          确认推进到「{{ labelOf(advTo) }}」
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  padding: 4px;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.head h3 {
  margin: 0 0 4px;
}
.sub {
  color: var(--el-text-color-secondary);
  font-size: 13px;
}
.ops {
  display: flex;
  align-items: center;
  gap: 8px;
}
.note {
  margin-top: 12px;
}
.stats {
  display: flex;
  gap: 32px;
  margin-top: 16px;
}
.stat__v {
  font-size: 22px;
  font-weight: 700;
}
.stat__v--warn {
  color: var(--el-color-warning);
}
.stat__l {
  margin-top: 2px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.table-card {
  margin-top: 12px;
}
.qty__v {
  font-variant-numeric: tabular-nums;
}
.qty__v--bad {
  color: var(--el-color-warning);
  font-weight: 700;
}
.qty__d {
  color: var(--el-color-warning);
  font-size: 12px;
}
.muted {
  color: var(--el-text-color-placeholder);
}
/* 订单进度：状态分布 chips（⚠️ 停在 cut_off 的高亮 —— 那是「没跟上」） */
.bd {
  display: inline-block;
  margin: 0 4px 2px 0;
  padding: 1px 6px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 3px;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
.bd--warn {
  border-color: var(--el-color-warning);
  color: var(--el-color-warning);
  font-weight: 600;
}
.bd__warn {
  margin-top: 2px;
  color: var(--el-color-warning);
  font-size: 12px;
}
/* 推进弹窗 */
.adv {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 10px 0;
}
.adv__from {
  color: var(--el-text-color-placeholder);
  text-decoration: line-through;
}
.adv__arrow {
  color: var(--el-text-color-secondary);
}
.adv__to {
  font-size: 18px;
  font-weight: 700;
}
.adv__hint {
  margin-bottom: 12px;
}
.dlg .form {
  margin-top: 8px;
}
.hint {
  margin-left: 10px;
}
.diff {
  border-top: 1px solid var(--el-border-color-lighter);
  padding-top: 10px;
}
.diff__t {
  font-weight: 600;
  margin-bottom: 6px;
}
.diff__list {
  margin: 0;
  padding-left: 18px;
}
.diff__k {
  display: inline-block;
  min-width: 72px;
  color: var(--el-text-color-secondary);
}
.diff__from {
  color: var(--el-text-color-placeholder);
  text-decoration: line-through;
}
.diff__arrow {
  margin: 0 6px;
}
.diff__to {
  font-weight: 600;
}
</style>
