<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  fetchSchedule,
  runScheduleTask,
  type ScheduleListResult,
  type ScheduleRow,
} from '@/api/schedule';

/**
 * 跑批时刻表（运营后台 · D64 查看 / D65 手动补跑）
 *
 * ## 收口的是哪一件挂账
 * `GET /admin/schedule` 自 M4-1 就有（服务端注释已把它当作「外部可观测证据」），
 * 但**一直没有页面** —— 运营要看时刻表只能手输 URL，或者去看日志。
 * 结果是两类故障没有出口：
 *   · 「某个任务没注册上」——`registeredCron` 为 `null` ⇒ 该任务**永远不会跑**，
 *     而失败形态是**没有任何报错**（#49 的接线部分就是把 @Cron 改成运行时注册，
 *     注册环节坏掉只会静默不跑；e2e 全走补跑接口，也发现不了）；
 *   · 「跑批没跑成，今天要补一次」——补跑口存在，但没人知道它存在。
 *
 * ## ⚠️ 本页最重要的一列是「实际注册 cron」，不是「生效时刻」
 * 两者**可能不同**，而且不同是**特性不是 bug**：运营把截单时刻从 `24:00` 改成 `23:30`，
 * 生效时刻立刻变、cron 也会热重载 —— 此时「出厂 cron」还是老的。
 * 故本页把三个值**并排摆出来**（生效时刻 / 实际注册 / 出厂），
 * 让「配置生没生效」变成一眼可见，而不是靠人去比对两份东西。
 *
 * ## ⚠️ 端上不复刻任何服务端规则
 * · 中文日期语义（`dateKindLabel`）、职责（`what`）、实装状态（`implemented`）
 *   全部由服务端下发 —— 端上不自造第二份映射（同族 #15 / #63 / #67 / #76）。
 * · 「是否被配置覆写」用的是 `registeredCron !== cron` 这个**纯字符串比较**，
 *   不做 `时间 → cron` 的换算（`24:00` 折算成 `0` 点是服务端规则，端上再写一遍就是第二份真相）。
 */
const loading = ref(false);
const running = ref(false);
const data = ref<ScheduleListResult | null>(null);

const rows = computed<ScheduleRow[]>(() => data.value?.list ?? []);
const summary = computed(() => data.value?.summary ?? { total: 0, implemented: 0, registered: 0 });

/**
 * 有任务**未注册**时给出醒目提示（不是「列表少了几行」，而是「它永远不会跑」）
 *
 * ⚠️ 判据是 `registeredCron === null`，**不是** `list.length < total` ——
 *    后者恒假（服务端固定列出全部任务），会把「任务没注册」这件事彻底藏起来。
 */
const unregistered = computed(() => rows.value.filter((r) => r.registeredCron === null));
const unimplemented = computed(() => rows.value.filter((r) => !r.implemented));

/** 被配置覆写的任务（出厂 cron ≠ 实际注册 cron） */
const overridden = computed(() => rows.value.filter((r) => r.registeredCron !== r.cron));

async function load() {
  loading.value = true;
  try {
    data.value = await fetchSchedule();
  } catch (e) {
    ElMessage.error((e as Error).message || '加载跑批时刻表失败');
  } finally {
    loading.value = false;
  }
}

// ------------------------------------------------------------------ D65 补跑

const runDialog = ref(false);
const runTarget = ref<ScheduleRow | null>(null);
const runDate = ref('');
/** 补跑出参（各任务形状不同 → 原样展示 JSON，不编造字段） */
const runResult = ref<string | null>(null);

function openRun(row: ScheduleRow) {
  runTarget.value = row;
  runDate.value = '';
  runResult.value = null;
  runDialog.value = true;
}

async function confirmRun() {
  const row = runTarget.value;
  if (!row) return;
  try {
    // ⚠️ 二次确认**不可省**：本接口会改写历史数据（把某个已过日期的订单批量置为已截单），
    //    且服务端只对 super_admin / admin 开放 —— 能点开本页的人**恰好**是能改的人。
    await ElMessageBox.confirm(
      `补跑「${row.what}」，目标日期：${runDate.value || '按该任务的日期语义自动推导'}。\n\n` +
        '补跑会**改写历史数据**（例如把已过日期的订单批量置为已截单），并写一条操作日志。确认执行？',
      `确认补跑 · ${row.task}`,
      { type: 'warning', confirmButtonText: '确认补跑', cancelButtonText: '取消' },
    );
  } catch {
    return; // 用户取消
  }

  running.value = true;
  try {
    const r = await runScheduleTask(row.task, runDate.value || undefined);
    runResult.value = JSON.stringify(r, null, 2);
    ElMessage.success(`补跑完成：${r.task} · ${r.date} · ${r.durationMs}ms`);
    await load();
  } catch (e) {
    ElMessage.error((e as Error).message || '补跑失败');
  } finally {
    running.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="page">
    <el-card shadow="never">
      <div class="head">
        <div>
          <h3>跑批时刻表</h3>
          <p class="sub">8 个定时任务的触发时刻、目标日期语义与实装状态；可在本页手动补跑</p>
        </div>
        <div class="ops">
          <el-button @click="load">刷新</el-button>
        </div>
      </div>

      <el-alert
        v-if="unregistered.length"
        type="error"
        show-icon
        :closable="false"
        class="note"
        :title="`有 ${unregistered.length} 个任务未注册 —— 它们永远不会被触发，且不会有任何报错`"
      >
        <div>
          未注册：<b>{{ unregistered.map((r) => r.task).join(' / ') }}</b> 。请检查服务启动日志里
          <code>ScheduleRegistrar</code> 的注册横幅， 或确认环境变量
          <code>TASKS_ENABLED</code> 未被误设为 <code>false</code>。
        </div>
      </el-alert>

      <el-alert
        v-else
        type="success"
        show-icon
        :closable="false"
        class="note"
        :title="`全部 ${summary.total} 个任务均已注册（${summary.registered}/${summary.total}）· 已实装（${summary.implemented}/${summary.total}）`"
      />

      <el-alert
        v-if="unimplemented.length"
        type="warning"
        show-icon
        :closable="false"
        class="note"
        title="有任务已声明但代码未实装（如实标注，不代表已上线）"
      >
        <div v-for="r in unimplemented" :key="r.task">
          · <b>{{ r.task }}</b
          >：{{ r.pendingNote ?? '待后续批次实装' }}
        </div>
      </el-alert>

      <el-alert
        type="info"
        show-icon
        :closable="false"
        class="note"
        title="三个「时刻」字段的区别 —— 它们可能不同，而不同是特性不是 bug"
      >
        <div>
          <b>生效时刻</b>是配置覆写后的真实时刻；<b>实际注册</b>是按它生成的 cron（
          <code>24:00</code> 在 cron 里折算为 <code>0</code> 点，与本列显示的时刻<b>同源</b>）；
          <b>出厂</b>是代码里的默认口径，只在没有任何配置覆写时与实际注册相同。
        </div>
        <div v-if="overridden.length" class="muted">
          当前被配置覆写的任务：{{ overridden.map((r) => r.task).join(' / ') }}
          —— 此时改配置会<b>同时</b>改变下单窗口与跑批时刻（服务端热重载，无需重启）。
        </div>
      </el-alert>

      <el-table :data="rows" border stripe size="small" class="table">
        <el-table-column label="任务" min-width="150">
          <template #default="{ row }">
            <div class="task">{{ row.task }}</div>
            <div class="muted">{{ row.what }}</div>
          </template>
        </el-table-column>

        <el-table-column label="生效时刻" width="100" align="center">
          <template #default="{ row }">
            <el-tag
              v-if="row.registeredCron !== row.cron"
              type="warning"
              effect="plain"
              size="small"
            >
              {{ row.effectiveAt }}
            </el-tag>
            <span v-else>{{ row.effectiveAt }}</span>
          </template>
        </el-table-column>

        <el-table-column label="实际注册 cron" width="150" align="center">
          <template #default="{ row }">
            <span v-if="row.registeredCron" class="mono">{{ row.registeredCron }}</span>
            <el-tag v-else type="danger" effect="dark" size="small">未注册</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="出厂 cron" width="140" align="center">
          <template #default="{ row }">
            <span class="mono muted">{{ row.cron }}</span>
          </template>
        </el-table-column>

        <el-table-column label="目标日期" width="150" align="center">
          <template #default="{ row }">
            <span>{{ row.dateKindLabel }}</span>
          </template>
        </el-table-column>

        <el-table-column prop="timeZone" label="时区" width="130" align="center" />

        <el-table-column label="实装" width="80" align="center">
          <template #default="{ row }">
            <el-tag v-if="row.implemented" type="success" effect="plain" size="small"
              >已实装</el-tag
            >
            <el-tag v-else type="info" effect="plain" size="small">未实装</el-tag>
          </template>
        </el-table-column>

        <el-table-column label="操作" width="90" align="center">
          <template #default="{ row }">
            <el-button
              link
              type="primary"
              size="small"
              :disabled="!row.implemented"
              @click="openRun(row as ScheduleRow)"
            >
              补跑
            </el-button>
          </template>
        </el-table-column>
      </el-table>

      <p class="muted foot">
        改动跑批时刻请到「系统配置」页改时间类配置（开团 / 截单 / 送达 / 自动确认 / 佣金入账 —— 这 5
        项已接线，保存后<b>立即</b>同时改变下单窗口与跑批时刻，无需重启服务）；
        其余时刻为纯内部节奏，不可配。
      </p>
    </el-card>

    <el-dialog v-model="runDialog" :title="`手动补跑 · ${runTarget?.task ?? ''}`" width="560px">
      <el-alert type="warning" show-icon :closable="false" class="note" title="补跑会改写历史数据">
        <div>
          与跑批<b>共用同一个执行口</b>，因此算出来的数与跑批一致；但补跑<b>不被调度锁挡住</b>
          （锁的语义是「同一目标日期只跑一次」，而补跑恰恰是为「没跑成」准备的）。
          重复补跑的安全性由各服务的业务幂等保证。
        </div>
      </el-alert>

      <el-descriptions :column="1" border size="small" class="desc">
        <el-descriptions-item label="任务职责">{{ runTarget?.what }}</el-descriptions-item>
        <el-descriptions-item label="目标日期语义">
          {{ runTarget?.dateKindLabel }}
        </el-descriptions-item>
        <el-descriptions-item label="生效时刻">{{ runTarget?.effectiveAt }}</el-descriptions-item>
      </el-descriptions>

      <div class="field">
        <span class="label">目标日期</span>
        <el-date-picker
          v-model="runDate"
          type="date"
          value-format="YYYY-MM-DD"
          placeholder="留空 = 按上方「目标日期语义」自动推导"
          clearable
          style="width: 320px"
        />
      </div>

      <el-input
        v-if="runResult"
        :model-value="runResult"
        type="textarea"
        :rows="8"
        readonly
        class="result"
      />

      <template #footer>
        <el-button @click="runDialog = false">关闭</el-button>
        <el-button type="primary" :loading="running" @click="confirmRun">执行补跑</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<style scoped>
.page {
  padding: 16px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 12px;
}
.head h3 {
  margin: 0 0 4px;
  font-size: 16px;
}
.sub {
  margin: 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.note {
  margin-bottom: 10px;
}
.table {
  margin-top: 4px;
}
.task {
  font-weight: 600;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}
.muted {
  color: var(--el-text-color-secondary);
  font-size: 12px;
  line-height: 1.6;
}
.foot {
  margin: 12px 0 0;
}
.desc {
  margin: 12px 0;
}
.field {
  display: flex;
  align-items: center;
  gap: 10px;
}
.field .label {
  color: var(--el-text-color-regular);
  font-size: 13px;
  white-space: nowrap;
}
.result {
  margin-top: 12px;
}
</style>
