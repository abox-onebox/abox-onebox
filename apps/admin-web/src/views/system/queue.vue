<script setup lang="ts">
/**
 * 队列状态（运营后台 · `GET /admin/queue`）
 *
 * ## 收口的是哪一件挂账
 *
 * `GET /admin/queue` 自 M4-3 就有（`src/queues/queue-admin.controller.ts`），
 * 但**从来没有页面** —— 全仓 0 引用。它的存在理由写在控制器头注里：
 *
 * > 队列的**最大风险不是「失败」，而是「静默失效」** —— 任务进不去队列、
 * > 进去了没人消费、重试耗尽只剩一条会轮转掉的日志，三种都**不会让接口报错**。
 *
 * 于是这三个数（积压 / 重试中 / 死信）在界面上无处可看，
 * 「退款没重试」只能靠用户投诉倒推。本页把这条可观测链路的**出口**补上。
 *
 * ## ⭐ 本页第一要看的是 `driver` 与 `durable`，不是积压数
 *
 * `driver=memory` + `durable=false` = 进程内队列，**重启即丢**，
 * 且多实例部署时任务不会跨实例分发。此时积压数哪怕是 0 也不代表健康 ——
 * 它只说明「此刻内存里没有待办」。故驱动非 redis 时给一条 error 级告警条。
 *
 * ## ⚠️ 本页只读
 *
 * 没有补跑 / 重投 / 清空按钮：重投一个退款任务会**真实出款**，
 * 一期没有「按 job id 重投」的安全通道，宁可让人去查操作日志（`module=queue`）。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';

import { fetchQueueStatus, type QueueStats } from '@/api/queue';

const loading = ref(false);
const data = ref<QueueStats | null>(null);

const rows = computed(() => data.value?.queues ?? []);

/** ⭐ 死信 = 重试耗尽、已没人再管 —— 唯一必须人工接手的信号 */
const deadTotals = computed(() => rows.value.reduce((s, r) => s + r.failed, 0));
const pendingTotals = computed(() =>
  rows.value.reduce((s, r) => s + r.waiting + r.active + r.delayed, 0),
);

const isDurable = computed(() => data.value?.durable === true);

async function load() {
  loading.value = true;
  try {
    data.value = await fetchQueueStatus();
  } catch (e) {
    ElMessage.error((e as Error).message || '加载队列状态失败');
  } finally {
    loading.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading" class="page">
    <el-card shadow="never">
      <div class="head">
        <div>
          <h3>队列状态</h3>
          <p class="sub">
            三个异步队列的积压与死信计数（支付后续 / 退款后续 / 结算后续）· 只读，无重投入口
          </p>
        </div>
        <div class="ops">
          <el-button @click="load">刷新</el-button>
        </div>
      </div>

      <el-alert
        v-if="!isDurable"
        type="error"
        show-icon
        :closable="false"
        class="note"
        :title="`当前驱动 ${data?.driver ?? '—'} · durable=false —— 进程重启任务即丢，多实例不跨实例分发`"
      >
        <div>
          这是本地开发 / e2e 形态。生产请把 <code>QUEUE_DRIVER=redis</code>（启动时必须连上，
          连不上会拒绝启动 —— 队列刻意不做静默降级）。此时下表计数只反映当前这一个进程的内存。
        </div>
      </el-alert>

      <el-alert
        v-else
        type="success"
        show-icon
        :closable="false"
        class="note"
        title="驱动为 redis · durable=true —— 任务持久在 Redis，进程重启后仍可继续消费"
      />

      <el-alert
        v-if="deadTotals > 0"
        type="warning"
        show-icon
        :closable="false"
        class="note"
        :title="`有 ${deadTotals} 个任务已进入死信（重试耗尽）—— 没有任何进程会再管它们`"
      >
        <div>
          死信会同时写一条操作日志（<code>module=queue</code> /
          <code>action=任务重试耗尽</code>），请到「系统 → 操作日志」按该条件检索，
          日志里带具体的业务对象（退款单 / 订单号）。
        </div>
      </el-alert>

      <div class="stats">
        <div class="stats__item">
          <span class="stats__label">驱动</span>
          <span class="stats__value mono">{{ data?.driver ?? '—' }}</span>
        </div>
        <div class="stats__item">
          <span class="stats__label">最大尝试次数</span>
          <span class="stats__value">{{ data?.attempts ?? '—' }}</span>
        </div>
        <div class="stats__item">
          <span class="stats__label">退避基数</span>
          <span class="stats__value">{{ data?.backoffBaseMs ?? '—' }} ms</span>
        </div>
        <div class="stats__item">
          <span class="stats__label">待处理合计</span>
          <span class="stats__value">{{ pendingTotals }}</span>
        </div>
        <div class="stats__item">
          <span class="stats__label">死信合计</span>
          <span class="stats__value stats__value--warn">{{ deadTotals }}</span>
        </div>
      </div>

      <el-table :data="rows" border stripe size="small" class="table">
        <el-table-column prop="label" label="队列" min-width="140">
          <template #default="{ row }">
            <div class="task">{{ row.label }}</div>
            <div class="muted mono">{{ row.queue }}</div>
          </template>
        </el-table-column>
        <el-table-column prop="waiting" label="等待中" width="90" align="right" />
        <el-table-column prop="active" label="执行中" width="90" align="right" />
        <el-table-column prop="delayed" label="退避重试" width="100" align="right">
          <template #default="{ row }">
            <el-tag v-if="row.delayed > 0" type="warning" effect="plain" size="small">
              {{ row.delayed }}
            </el-tag>
            <span v-else>0</span>
          </template>
        </el-table-column>
        <el-table-column label="死信" width="90" align="right">
          <template #default="{ row }">
            <el-tag v-if="row.failed > 0" type="danger" effect="dark" size="small">
              {{ row.failed }}
            </el-tag>
            <span v-else>0</span>
          </template>
        </el-table-column>
        <el-table-column prop="completed" label="已完成" width="90" align="right" />
        <template #empty><el-empty description="队列尚未初始化（服务启动中）" /></template>
      </el-table>

      <el-alert type="info" show-icon :closable="false" class="note" title="四个计数分别是什么意思">
        <div>
          <b>等待中</b>：已入队、还没轮到；<b>执行中</b>：正在跑；<b>退避重试</b>：上一次失败、按
          <code>backoffBaseMs × 2^(n-1)</code>
          稍后再试（<b>不是失败</b>）；<b>死信</b>：重试次数用尽、
          <b>已经没有进程会再管它</b>，只留一条操作日志。
        </div>
      </el-alert>

      <p class="muted foot">
        本页<b>只读</b>，刻意不提供「重投」按钮 —— 重投一个退款任务会<b>真实出款</b>， 一期没有按
        job id 安全重放的通道。要处理死信请去「系统 → 操作日志」找 <code>module=queue</code>
        的那条，照里面的业务对象人工跟进。
      </p>
    </el-card>
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
.stats {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 12px 0;
}
.stats__item {
  flex: 1;
  min-width: 120px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  background: var(--el-fill-color-light);
  border-radius: 4px;
}
.stats__label {
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.stats__value {
  font-size: 18px;
  font-weight: 600;
}
.stats__value--warn {
  color: var(--el-color-danger);
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
</style>
