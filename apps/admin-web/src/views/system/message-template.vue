<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">订阅消息模板</h2>
    <p class="page-container__meta">
      原型页 / 模块：P36 · M37 ｜ 接口：D59 读取 / D60 编辑单条（写日志）
    </p>

    <el-alert type="info" :closable="false" show-icon class="block">
      <template #title>口径说明</template>
      <p class="block__text">{{ data?.note }}</p>
    </el-alert>

    <div class="toolbar">
      <span class="toolbar__stat">
        共 {{ data?.summary.total ?? 0 }} 个场景 ｜ 已启用 {{ data?.summary.enabled ?? 0 }} ｜
        已接入投递 {{ data?.summary.live ?? 0 }} ｜ 待接入 {{ data?.summary.pending ?? 0 }}
      </span>
      <el-button :loading="loading" @click="load">刷新</el-button>
    </div>

    <el-card v-for="t in data?.list ?? []" :key="t.scene" shadow="never" class="card">
      <template #header>
        <div class="card__head">
          <span class="card__title">{{ t.label }}</span>
          <el-tag v-if="t.mandatory" size="small" type="danger" effect="plain">必推项</el-tag>
          <el-tag v-if="t.wiring === 'live'" size="small" type="success" effect="plain">
            已接入投递
          </el-tag>
          <el-tag v-else size="small" type="warning" effect="plain">一期无投递点</el-tag>
          <el-tag v-if="!t.persisted" size="small" type="info" effect="plain">尚未落库</el-tag>
        </div>
      </template>

      <p class="card__desc">触达对象：{{ t.audience }} ｜ 触发时机：{{ t.trigger }}</p>

      <div class="chips">
        <span class="chips__label">渠道</span>
        <el-tag
          v-for="c in t.channels"
          :key="c.key"
          size="small"
          :type="c.requirementMet ? 'success' : 'warning'"
          effect="plain"
        >
          {{ c.label }}<span v-if="!c.requirementMet"> · 缺{{ c.requirementFieldLabel }}</span>
        </el-tag>
      </div>

      <p v-if="t.pendingReason" class="card__warn">{{ t.pendingReason }}</p>
      <p v-if="t.note" class="card__note">{{ t.note }}</p>
      <p class="card__meta">代码消费点：{{ t.consumedBy }} ｜ 场景键：{{ t.scene }}</p>

      <div class="form">
        <div class="form__row">
          <span class="form__label">启用</span>
          <el-switch
            v-model="draft[t.scene].enabled"
            :active-value="1"
            :inactive-value="0"
            :disabled="saving === t.scene"
          />
          <span class="form__hint">
            启用后代码即按本场景投递；缺必要条件会被拒绝（不会出现「已启用但发不出去」）
          </span>
        </div>

        <div class="form__row">
          <span class="form__label">微信模板 ID</span>
          <el-input
            v-model="draft[t.scene].wechatTemplateId"
            class="form__input"
            placeholder="在微信公众平台创建订阅消息模板后填入；留空表示未配置"
            :disabled="saving === t.scene"
          />
        </div>

        <div class="form__row">
          <span class="form__label">微信群文案</span>
          <el-input
            v-model="draft[t.scene].groupContent"
            type="textarea"
            :rows="2"
            class="form__input"
            placeholder="供人工复制发群；不会改变微信订阅消息的内容"
            :disabled="saving === t.scene"
          />
        </div>

        <div class="form__foot">
          <span class="form__vars">可用变量：{{ varText(t.variables) }}</span>
          <el-button
            size="small"
            type="primary"
            :loading="saving === t.scene"
            :disabled="!isDirty(t) || saving !== null"
            @click="save(t)"
          >
            保存
          </el-button>
        </div>

        <ul v-if="t.blockers.length" class="blockers">
          <li v-for="(b, i) in t.blockers" :key="i">启用条件未满足：{{ b }}</li>
        </ul>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';

import {
  MessageTemplateItemView,
  fetchMessageTemplates,
  updateMessageTemplate,
} from '@/api/system';

interface Draft {
  enabled: number;
  wechatTemplateId: string;
  groupContent: string;
}

const loading = ref(false);
const saving = ref<string | null>(null);
/** 每场景一份草稿（D60 是**单条**编辑，故不像配置页那样整批保存） */
const draft = reactive<Record<string, Draft>>({});
const data = ref<Awaited<ReturnType<typeof fetchMessageTemplates>> | null>(null);

function fill(list: MessageTemplateItemView[]): void {
  for (const t of list) {
    draft[t.scene] = {
      enabled: t.enabled ? 1 : 0,
      wechatTemplateId: t.wechatTemplateId ?? '',
      groupContent: t.groupContent ?? '',
    };
  }
}

function isDirty(t: MessageTemplateItemView): boolean {
  const d = draft[t.scene];
  if (!d) return false;
  return (
    d.enabled !== (t.enabled ? 1 : 0) ||
    d.wechatTemplateId !== (t.wechatTemplateId ?? '') ||
    d.groupContent !== (t.groupContent ?? '')
  );
}

/**
 * 变量清单文案
 *
 * ⚠️ 必须在 `script` 里拼：模板表达式里写不出字面的双花括号
 *    （`{{` 是 Vue 插值语法的开始标记，写在表达式里会直接把模板解析搞崩）。
 */
function varText(vars: string[]): string {
  if (!vars.length) return '无';
  return vars.map((v) => `{{${v}}}`).join(' ');
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    data.value = await fetchMessageTemplates();
    fill(data.value.list);
  } finally {
    loading.value = false;
  }
}

async function save(t: MessageTemplateItemView): Promise<void> {
  if (t.id === null) {
    ElMessage.warning('该场景尚未落库，请先执行种子导入');
    return;
  }
  const d = draft[t.scene];
  saving.value = t.scene;
  try {
    // 只提交**改动过**的字段：缺省 = 不改，显式 null = 清空（服务端据此区分语义）
    const patch: {
      enabled?: number;
      wechatTemplateId?: string | null;
      groupContent?: string | null;
    } = {};
    if (d.enabled !== (t.enabled ? 1 : 0)) patch.enabled = d.enabled;
    if (d.wechatTemplateId !== (t.wechatTemplateId ?? '')) {
      patch.wechatTemplateId = d.wechatTemplateId.trim() || null;
    }
    if (d.groupContent !== (t.groupContent ?? '')) {
      patch.groupContent = d.groupContent.trim() || null;
    }

    const r = await updateMessageTemplate(t.id, patch);
    ElMessage.success(r.note);
    await load();
  } catch {
    // 拦截器已统一提示；此处只需刷新，把服务端判定后的真实状态拉回来
    await load();
  } finally {
    saving.value = null;
  }
}

onMounted(load);
</script>

<style lang="scss" scoped>
.block {
  margin-bottom: $space-3;
}
.block__text {
  margin: 0;
  line-height: 1.7;
}
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: $space-3;
}
.toolbar__stat {
  color: $c-text-weak;
  font-size: $fs-caption;
}
.card {
  margin-bottom: $space-3;
}
.card__head {
  display: flex;
  align-items: center;
  gap: $space-1;
}
.card__title {
  font-weight: 600;
}
.card__desc,
.card__meta {
  margin: 0 0 $space-1;
  color: $c-text-weak;
  font-size: $fs-caption;
}
.card__warn {
  margin: 0 0 $space-1;
  color: $c-warning;
  font-size: $fs-caption;
  line-height: 1.6;
}
.card__note {
  margin: 0 0 $space-1;
  font-size: $fs-caption;
  line-height: 1.6;
}
.chips {
  display: flex;
  align-items: center;
  gap: $space-1;
  margin-bottom: $space-2;
}
.chips__label {
  color: $c-text-weak;
  font-size: $fs-caption;
}
.form {
  border-top: 1px solid $c-border;
  padding-top: $space-2;
}
.form__row {
  display: flex;
  align-items: center;
  gap: $space-2;
  margin-bottom: $space-2;
}
.form__label {
  width: 88px;
  flex: none;
  color: $c-text-weak;
  font-size: $fs-caption;
}
.form__input {
  max-width: 520px;
}
.form__hint {
  color: $c-text-weak;
  font-size: $fs-caption;
}
.form__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.form__vars {
  color: $c-text-weak;
  font-size: $fs-caption;
}
.blockers {
  margin: $space-1 0 0;
  padding-left: 1.2em;
  color: $c-warning;
  font-size: $fs-caption;
  line-height: 1.6;
}
</style>
