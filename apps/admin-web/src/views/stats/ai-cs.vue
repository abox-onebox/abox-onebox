<template>
  <div class="ai-cs">
    <el-alert
      class="ai-cs__tip"
      type="info"
      :closable="false"
      title="C 端智能客服预览（只读）"
      description="本页展示消费者在小程序内可见的内容：① 124 号令资质与标签公示；② 规则命中问答。运营可在此核对文案与公示信息，实际消费端由小程序调用 /api/v1/ai-cs/* 渲染。"
    />

    <!-- 124 号令公示预览 -->
    <el-card class="ai-cs__card" shadow="never">
      <template #header>
        <span class="ai-cs__title">124 号令 · 资质与标签公示</span>
        <el-button
          class="ai-cs__refresh"
          size="small"
          :loading="loadingCompliance"
          @click="loadCompliance"
          >刷新</el-button
        >
      </template>

      <template v-if="compliance">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="经营主体">{{
            compliance.filing.subjectName || '—'
          }}</el-descriptions-item>
          <el-descriptions-item label="备案编号">{{
            compliance.filing.filingNo || '（待补全）'
          }}</el-descriptions-item>
          <el-descriptions-item label="统一社会信用代码">{{
            compliance.filing.creditCode || '（待补全）'
          }}</el-descriptions-item>
          <el-descriptions-item label="经营范围">{{
            compliance.filing.businessScope || '—'
          }}</el-descriptions-item>
          <el-descriptions-item label="备案日期">{{
            compliance.filing.filingDate || '（待补全）'
          }}</el-descriptions-item>
        </el-descriptions>

        <div class="ai-cs__label-title">预包装食品标签必含字段</div>
        <div class="ai-cs__labels">
          <el-tag
            v-for="f in compliance.labelFields"
            :key="f"
            size="small"
            type="info"
            effect="plain"
            >{{ f }}</el-tag
          >
        </div>
        <p class="ai-cs__note">{{ compliance.note }}</p>
      </template>
      <el-empty v-else description="加载中…" />
    </el-card>

    <!-- 问答预览 -->
    <el-card class="ai-cs__card" shadow="never">
      <template #header>
        <span class="ai-cs__title">规则命中问答</span>
      </template>

      <div class="ai-cs__ask">
        <el-input
          v-model="question"
          type="textarea"
          :rows="2"
          maxlength="500"
          placeholder="输入消费者可能问的问题，如：你们有食品经营许可证吗 / 配料里有防腐剂吗 / 怎么下单"
        />
        <el-button type="primary" class="ai-cs__btn" :loading="asking" @click="runAsk"
          >试提问</el-button
        >
      </div>

      <template v-if="answer">
        <div class="ai-cs__intent">
          命中意图：<el-tag size="small">{{ answer.intent }}</el-tag>
          <el-tag v-if="answer.compliance" size="small" type="warning" effect="plain"
            >已挂载公示块</el-tag
          >
          <el-tag v-else size="small" type="info" effect="plain">未挂载公示</el-tag>
        </div>
        <p class="ai-cs__answer">{{ answer.answer }}</p>
        <el-alert
          v-if="answer.compliance"
          class="ai-cs__attach"
          type="success"
          :closable="false"
          :title="answer.compliance.title"
          :description="`标签字段：${answer.compliance.labelFields.join('、')}`"
        />
      </template>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { askCs, getCompliance124, type ComplianceBlock, type CsAnswer } from '@/api/ai-cs';

const compliance = ref<ComplianceBlock | null>(null);
const loadingCompliance = ref(false);
const question = ref('');
const asking = ref(false);
const answer = ref<CsAnswer | null>(null);

async function loadCompliance(): Promise<void> {
  loadingCompliance.value = true;
  try {
    compliance.value = await getCompliance124();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载公示失败');
  } finally {
    loadingCompliance.value = false;
  }
}

async function runAsk(): Promise<void> {
  const q = question.value.trim();
  if (!q) {
    ElMessage.warning('请先输入一个问题');
    return;
  }
  asking.value = true;
  try {
    answer.value = await askCs(q);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '提问失败');
  } finally {
    asking.value = false;
  }
}

onMounted(loadCompliance);
</script>

<style lang="scss" scoped>
.ai-cs {
  padding: 16px;

  &__tip {
    margin-bottom: 16px;
  }

  &__card {
    margin-bottom: 16px;
  }

  &__title {
    font-weight: 600;
    color: $c-text;
  }

  &__refresh {
    float: right;
  }

  &__label-title {
    margin: 16px 0 8px;
    color: $c-text-weak;
    font-size: 13px;
  }

  &__labels {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  &__note {
    margin: 12px 0 0;
    color: $c-text-weak;
    font-size: 12px;
  }

  &__ask {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  &__btn {
    align-self: flex-end;
  }

  &__intent {
    margin: 16px 0 8px;
    display: flex;
    align-items: center;
    gap: 8px;
  }

  &__answer {
    margin: 0;
    line-height: 1.7;
    color: $c-text;
  }

  &__attach {
    margin-top: 12px;
  }
}
</style>
