<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="680px"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <div v-if="result" class="batch">
      <!-- 一句话结论：成功 / 部分失败 / 全失败 / 一笔没动，四种都必须是人话 -->
      <el-alert :type="alertType" :closable="false" class="batch__tips">
        <template #title>{{ result.tips }}</template>
      </el-alert>

      <div class="batch__counts">
        <span class="batch__count batch__count--ok">成功 {{ result.counts.succeeded }}</span>
        <span class="batch__count batch__count--muted">跳过 {{ result.counts.skipped }}</span>
        <span class="batch__count batch__count--bad">失败 {{ result.counts.failed }}</span>
        <span v-if="result.counts.succeeded" class="batch__amount">
          合计 {{ fenToCny(result.amounts.handledFen) }}
        </span>
      </div>

      <!-- 失败：必须摆在第一个，运营是来处理这个的 -->
      <section v-if="result.failed.length" class="batch__section">
        <h4 class="batch__title batch__title--bad">未处理（{{ result.failed.length }}）</h4>
        <ul class="batch__list">
          <li v-for="item in result.failed" :key="item.id" class="batch__item">
            <span class="mono">{{ item.refundNo ?? `#${item.id}` }}</span>
            <span class="batch__why">{{ item.message }}</span>
          </li>
        </ul>
        <p class="batch__hint">
          可直接把这几笔重新勾选再提交一次：已成功的不会重复退，只会重试这几笔。
        </p>
      </section>

      <!-- 跳过：不是失败，但要说清为什么没动它 -->
      <section v-if="result.skipped.length" class="batch__section">
        <h4 class="batch__title">已跳过（{{ result.skipped.length }}）</h4>
        <ul class="batch__list">
          <li v-for="item in result.skipped" :key="item.id" class="batch__item">
            <span class="mono">{{ item.refundNo }}</span>
            <span class="batch__why">{{ item.reason }}</span>
          </li>
        </ul>
      </section>

      <section v-if="result.succeeded.length" class="batch__section">
        <h4 class="batch__title batch__title--ok">已处理（{{ result.succeeded.length }}）</h4>
        <ul class="batch__list">
          <li v-for="item in result.succeeded" :key="item.id" class="batch__item">
            <span class="mono">{{ item.refundNo }}</span>
            <span class="batch__why">
              {{ fenToCny(item.amountFen) }}
              <template v-if="result.action === 'approve'">
                （微信 {{ fenToCny(item.wxRefundedFen) }} · 余额
                {{ fenToCny(item.balanceRefundedFen) }}）
              </template>
              <template v-else>（订单回到「{{ item.orderStatus }}」）</template>
              <!-- 通道未受理 = 已排队重试：明说，否则运营会以为没退成再点一次 -->
              <b v-if="item.retryQueued" class="batch__queued">微信通道已排队重试</b>
            </span>
          </li>
        </ul>
      </section>

      <p v-if="result.input.dupCount || result.input.invalidCount" class="batch__hint">
        入参已收口：重复 {{ result.input.dupCount }} 个、无效 {{ result.input.invalidCount }} 个。
      </p>

      <!-- 断点续退：条件批量一次只处理一批，剩下的要能接着点 -->
      <el-alert
        v-if="scopeResult && scopeResult.remaining > 0"
        type="warning"
        :closable="false"
        class="batch__tips"
      >
        <template #title>{{ scopeResult.nextTip }}</template>
      </el-alert>
    </div>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">关闭</el-button>
      <el-button type="primary" @click="emit('refresh')">刷新列表</el-button>
      <el-button
        v-if="scopeResult && scopeResult.remaining > 0"
        type="warning"
        @click="emit('continue')"
      >
        继续处理剩余 {{ scopeResult.remaining }} 笔
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { BatchRefundResult, BatchScopeResult } from '@/api/finance';
import { fenToCny } from '@/utils/format';

/**
 * E5 批量退款**结果**弹窗
 *
 * ## 为什么单独一个组件
 * 批量最危险的不是「退错钱」，而是**结果看不清**：一屏 N 笔里夹着 3 笔失败，
 * 如果它们混在一句「操作完成」里，运营不会去看，那 3 笔就永远没人管。
 * 故结果必须**分三段摆出来、失败排在最上面**。
 *
 * ## 为什么不用「成功/失败」两态而要三段
 * 「跳过」是重试时最常见的一类：上一批已经处理过。把它染成失败色，运营会以为出事了；
 * 染成成功色，等于告诉他人已经退过了（其实这一轮没动它）。两者都是误导，所以单列。
 */
const props = defineProps<{
  modelValue: boolean;
  result: BatchRefundResult | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'refresh'): void;
  /** 断点续退：条件批量还剩下一批没处理 */
  (e: 'continue'): void;
}>();

/** 条件批量（带范围与剩余）才有「继续」；勾选批量没有这个概念 */
const scopeResult = computed(() => {
  const r = props.result as BatchScopeResult | null;
  return r && typeof r.remaining === 'number' ? r : null;
});

const title = computed(() => (props.result?.action === 'reject' ? '批量驳回结果' : '批量退款结果'));

const alertType = computed(() => {
  switch (props.result?.outcome) {
    case 'noop':
      return 'info';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'error';
    default:
      return 'success';
  }
});
</script>

<style lang="scss" scoped>
.batch {
  display: flex;
  flex-direction: column;
  gap: $space-3;

  &__tips {
    margin-bottom: 0;
  }

  &__counts {
    display: flex;
    flex-wrap: wrap;
    gap: $space-3;
    font-size: $fs-caption;
  }

  &__count {
    font-weight: 700;

    &--ok {
      color: $c-ok-fg;
    }

    &--bad {
      color: $c-warn-fg;
    }

    &--muted {
      color: $c-text-weak;
    }
  }

  &__amount {
    margin-left: auto;
    font-weight: 700;
    color: $c-warn-fg;
  }

  &__section {
    display: flex;
    flex-direction: column;
    gap: $space-1;
  }

  &__title {
    margin: 0;
    font-size: $fs-body;

    &--bad {
      color: $c-warn-fg;
    }

    &--ok {
      color: $c-ok-fg;
    }
  }

  &__list {
    max-height: 200px;
    margin: 0;
    padding-left: 18px;
    overflow-y: auto;
    font-size: $fs-caption;
    line-height: 1.8;
  }

  &__item {
    display: flex;
    gap: $space-2;
  }

  &__why {
    color: $c-text-weak;
  }

  &__queued {
    margin-left: $space-1;
    color: $c-warn-fg;
  }

  &__hint {
    margin: 0;
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.mono {
  font-family: Consolas, Monaco, monospace;
}
</style>
