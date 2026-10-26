<template>
  <div class="page-container">
    <h2 class="page-container__title">一键停售</h2>
    <p class="page-container__meta">
      模块：W1 · 接口：<code>GET / POST /admin/sales-pause</code>、<code
        >POST /admin/sales-pause/:id/resume</code
      >
      · 数据源 <code>ab_sales_pause</code>
    </p>

    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>只拦新单</b> —— 停售期间用户端无法下单、下单页按钮置灰，
        <b>已下的订单不受影响</b>（不退款、不取消、照常履约与结算）。
      </template>
    </el-alert>

    <!-- ─────────────── 当前状态 ─────────────── -->
    <el-alert
      :type="activePause ? 'error' : 'success'"
      :closable="false"
      class="note"
      :title="
        activePause
          ? `停售中：${activePause.mealDateFrom} ~ ${activePause.mealDateTo}`
          : '当前未停售，下单正常'
      "
    >
      <template v-if="activePause" #default>
        <div class="pause-reason">停售原因：{{ activePause.reason }}</div>
        <div class="dialog__tip">
          该区间内所有出餐日都不可下单；走出餐日 {{ activePause.mealDateTo }} 后自动失效。
          <b>不做定时停售、不做自动倒计时恢复</b> —— 提前解除请点右侧「立即恢复」。
        </div>
      </template>
    </el-alert>

    <div class="toolbar">
      <el-button type="primary" :loading="loading" @click="load">刷新</el-button>
      <el-button v-if="canWrite && !activePause" type="danger" @click="openCreate">
        发起停售
      </el-button>
      <el-button v-if="canWrite && activePause" type="warning" @click="onResume(activePause.id)">
        立即恢复
      </el-button>
      <span v-if="!canWrite" class="dialog__tip"> 只读：停售的写操作需要 super_admin / admin </span>
    </div>

    <!-- ─────────────── 历史区间 ─────────────── -->
    <el-table v-loading="loading" :data="rows" border size="small">
      <el-table-column label="出餐日区间" min-width="200">
        <template #default="{ row }">
          {{ row.mealDateFrom }}
          <span v-if="row.mealDateTo !== row.mealDateFrom">~ {{ row.mealDateTo }}</span>
          <span v-else class="dialog__tip">（单日）</span>
        </template>
      </el-table-column>
      <el-table-column prop="reason" label="停售原因" min-width="220" show-overflow-tooltip />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="row.resumedAt ? 'info' : 'danger'" size="small" effect="plain">
            {{ row.resumedAt ? '已恢复' : '仍生效' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="创建时间" width="160">
        <template #default="{ row }">{{ formatDateTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="恢复时间" width="160">
        <template #default="{ row }">{{
          row.resumedAt ? formatDateTime(row.resumedAt) : '—'
        }}</template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
        <template #default="{ row }">
          <el-button
            v-if="canWrite && !row.resumedAt"
            link
            type="primary"
            @click="onResume(row.id)"
          >
            恢复
          </el-button>
          <span v-else class="dialog__tip">—</span>
        </template>
      </el-table-column>
    </el-table>

    <p class="footnote">
      提示：<b>允许「起始 = 截止」</b>（停单日就是这种形态，可直接用弹窗里的「停售明日」）；
      写入即刻生效，用户端下一次拉取套餐／下单立即体现，不需要等待。
    </p>

    <!-- ─────────────── 发起停售 ─────────────── -->
    <el-dialog v-model="dialog.visible" title="发起停售" width="480px">
      <el-alert type="warning" :closable="false" class="note">
        <template #title>
          停售会立刻拦住<b>全部办公楼</b>的新订单。原因会下发到用户端展示，请写一句人话。
        </template>
      </el-alert>

      <el-form :model="dialog" label-width="96px">
        <el-form-item label="出餐日区间">
          <el-date-picker
            v-model="dialog.from"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="起始出餐日（含）"
            style="width: 160px"
          />
          <span class="range-sep">至</span>
          <el-date-picker
            v-model="dialog.to"
            type="date"
            value-format="YYYY-MM-DD"
            placeholder="截止出餐日（含）"
            style="width: 160px"
          />
          <el-button link type="primary" @click="fillTomorrow">停售明日</el-button>
        </el-form-item>

        <el-form-item label="停售原因">
          <el-input
            v-model="dialog.reason"
            type="textarea"
            :rows="3"
            maxlength="255"
            show-word-limit
            placeholder="不少于 4 字，例如：设备检修，今日暂停接单"
          />
          <div class="dialog__tip">
            至少 4 字（后端 <code>@MinLength(4)</code>）；不足会落到 10001 格式校验。
          </div>
        </el-form-item>
      </el-form>

      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="danger" :loading="dialog.saving" @click="submit">确认停售</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  createSalesPause,
  fetchSalesPauses,
  resumeSalesPause,
  type SalesPauseRow,
} from '@/api/system';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime } from '@/utils/format';

/**
 * ⚠️ 状态读取**只走** `GET /admin/sales-pause`（§13.1 的两条「不得」）：
 *
 *    1. **不读 `ab_config` / 不调 `BizConfigService`**：那套读路径有 60 秒进程内 TTL，
 *       且 `ensureLoaded()` 的 catch 静默 fail-open。停售要的是「立刻」，走它会出现
 *       「后台已停售、用户端仍可下单最多 60 秒」且**零报错** —— 最坏的一种静默失败。
 *    2. 不依赖 `OrderAvailabilityService.salesPaused()` —— 后端 private 且当前是占位实现。
 *
 * ⚠️ 本页**不带任何 N2 停用闸门码**（60006 / 60007 / 60012 / 60013 · §13.3）：
 *    停售是「临时、全局、不动历史订单」，楼宇停用才是「长期下线一栋楼、要过未完结订单闸门」。
 *    复用闸门的后果是静默的 —— 运营点了开关、界面显示成功、实际没生效。
 */
const auth = useAuthStore();
/** ⚠️ 真正的越权闸门是后端 `@Roles('super_admin','admin')`，这里只做按钮显隐（同 operation-request）*/
const canWrite = computed(() => auth.role === 'super_admin' || auth.role === 'admin');

const loading = ref(false);
const rows = ref<SalesPauseRow[]>([]);

/**
 * 仍生效的区间（`resumedAt` 为 null）—— 多条重叠时以 **id 最大** 的那条为准
 *
 * ⚠️ 不能写成「取第一条」：GET 返回的是**全部**（生效中 + 已恢复混在一起），
 *    只是整体按 id 倒序 —— 「第一条」可能是已恢复的旧区间。
 *    §7.3 刻意允许重叠区间（「停售明天」+「停售下周一」是两条独立记录）。
 */
const activePause = computed(() => {
  const active = rows.value.filter((r) => !r.resumedAt);
  if (!active.length) return null;
  return active.reduce((a, b) => (b.id > a.id ? b : a));
});

const dialog = reactive({
  visible: false,
  saving: false,
  from: '',
  to: '',
  reason: '',
});

async function load() {
  loading.value = true;
  try {
    // 裸数组出参（见 `api/system.ts` 的同名注释）；`?? []` 只防传输层给 null，不是解信封
    rows.value = (await fetchSalesPauses()) ?? [];
  } finally {
    loading.value = false;
  }
}

/** 「停售明日」= 起始与截止同一天（§7.4：允许 from == to，不做第二套开关）*/
function fillTomorrow() {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  const s = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(
    t.getDate(),
  ).padStart(2, '0')}`;
  dialog.from = s;
  dialog.to = s;
}

function openCreate() {
  dialog.from = '';
  dialog.to = '';
  dialog.reason = '';
  dialog.visible = true;
}

async function submit() {
  if (!dialog.from || !dialog.to || dialog.reason.trim().length < 4) {
    ElMessage.warning('请选择出餐日区间，并填写不少于 4 字的停售原因');
    return;
  }
  dialog.saving = true;
  try {
    await createSalesPause({
      mealDateFrom: dialog.from,
      mealDateTo: dialog.to,
      reason: dialog.reason.trim(),
    });
    ElMessage.success('已停售，即刻生效');
    dialog.visible = false;
    await load();
  } finally {
    dialog.saving = false;
  }
}

async function onResume(id: number) {
  try {
    await ElMessageBox.confirm('恢复后立即允许下单（已下的订单不受影响）。确认恢复？', '确认恢复', {
      type: 'warning',
      confirmButtonText: '确认恢复',
      cancelButtonText: '再想想',
    });
  } catch {
    return;
  }
  await resumeSalesPause(id);
  ElMessage.success('已恢复，下单已放开');
  await load();
}

onMounted(load);
</script>

<style lang="scss" scoped>
.note {
  margin-bottom: $space-3;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-3;
}

.pause-reason {
  margin-bottom: $space-1;
}

.range-sep {
  margin: 0 $space-2;
  color: $c-text-weak;
}

.footnote {
  margin-top: $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;
}
</style>
