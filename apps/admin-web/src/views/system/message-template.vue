<template>
  <div v-loading="loading" class="page-container">
    <h2 class="page-container__title">通知模板</h2>
    <p class="page-container__meta">
      原型页 / 模块：P36 · M37 ｜ 接口：D59 读取 / D60 编辑单条（写日志）· F5 到达率 / 编排
    </p>

    <el-tabs v-model="tab" class="tabs">
      <el-tab-pane label="模板配置" name="config">
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
              <div class="form__stack">
                <el-input
                  v-model="draft[t.scene].wechatTemplateId"
                  class="form__input"
                  placeholder="在微信公众平台创建订阅消息模板后填入；留空表示未配置"
                  :disabled="saving === t.scene"
                />
                <!-- ⚠️ 这行是给运营照着选模板用的：微信只认关键词编号，
                     选到的模板关键词类型/顺序不一致，投递会被 47003 拒掉 -->
                <span v-if="t.wxFieldsHint" class="form__hint">
                  选模板时关键词须为：{{ t.wxFieldsHint }}
                  （顺序与类型都要一致，否则微信会拒发）
                </span>
              </div>
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
      </el-tab-pane>

      <el-tab-pane label="到达率与编排" name="reach">
        <el-alert
          v-if="reach"
          :type="reach.summary.attempted === 0 ? 'warning' : 'info'"
          :closable="false"
          show-icon
          class="block"
        >
          <template #title>
            {{ reach.summary.attempted === 0 ? '区间内没有任何投递记录' : '口径说明' }}
          </template>
          <p class="block__text">{{ reach.note }}</p>
        </el-alert>

        <div class="toolbar">
          <el-date-picker
            v-model="range"
            type="daterange"
            value-format="YYYY-MM-DD"
            start-placeholder="起始日"
            end-placeholder="截止日"
            :clearable="false"
            @change="loadReach"
          />
          <span class="toolbar__stat">
            尝试投递 {{ reach?.summary.attempted ?? 0 }} ｜ 成功
            {{ reach?.summary.success ?? 0 }} ｜ 失败 {{ reach?.summary.failed ?? 0 }} ｜ 整体到达率
            {{ rateText(reach?.summary.reachRate) }}
          </span>
          <el-button :loading="reachLoading" @click="loadReach">刷新</el-button>
        </div>

        <el-table :data="reach?.scenes ?? []" size="small" border class="table">
          <el-table-column prop="label" label="场景" min-width="170" />
          <el-table-column label="接线" width="110">
            <template #default="{ row }">
              <el-tag
                size="small"
                :type="row.wiring === 'live' ? 'success' : 'info'"
                effect="plain"
              >
                {{ wiringText(row.wiring) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="启用" width="86">
            <template #default="{ row }">
              <el-tag size="small" :type="row.enabled ? 'success' : 'warning'" effect="plain">
                {{ row.enabled ? '已启用' : '未启用' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="attempted" label="尝试投递" width="96" align="right" />
          <el-table-column prop="success" label="成功" width="80" align="right" />
          <el-table-column prop="failed" label="失败" width="80" align="right" />
          <el-table-column label="到达率" width="96" align="right">
            <template #default="{ row }">{{ rateText(row.reachRate) }}</template>
          </el-table-column>
        </el-table>
        <p class="hint">
          口径提示：到达率 = 成功 ÷ 已尝试投递。分母不含「因未启用被跳过」的通知 —— ab_message
          按纪律只记「发过什么」，故本页算不出「应发未发」（那看上方「模板配置」的开关与闸门）。
          「—」表示区间内没有任何尝试投递，与 0% 不是一回事。
        </p>

        <h3 class="sect">按日</h3>
        <el-empty
          v-if="!reach?.daily?.length"
          description="区间内没有投递记录（这不是接口故障，原因见上方说明）"
          :image-size="72"
        />
        <el-table v-else :data="reach.daily" size="small" border class="table">
          <el-table-column prop="date" label="日期" width="130" />
          <el-table-column prop="attempted" label="尝试投递" width="96" align="right" />
          <el-table-column prop="success" label="成功" width="80" align="right" />
          <el-table-column prop="failed" label="失败" width="80" align="right" />
          <el-table-column label="到达率" width="96" align="right">
            <template #default="{ row }">{{ rateText(row.reachRate) }}</template>
          </el-table-column>
        </el-table>

        <h3 class="sect">手动编排 · 截单提醒</h3>
        <el-card shadow="never" class="card">
          <p class="card__desc">
            受众：{{ orch?.audienceLabel ?? '近 14 天下过单、且目标发货日尚未下单的用户' }}
          </p>
          <p class="card__meta">
            真源《系统地图》F5「'忘了下单'和'忘了取货'是最冤的两笔损失」——
            本区就是「忘了下单」的执行口（「忘了取货」由「团长送达通知」承载）。
            注意：自动跑批待微信订阅消息模板审核通过后接入，在此之前由运营在此手动触发。
          </p>
          <div class="form__row">
            <span class="form__label">目标发货日</span>
            <el-date-picker
              v-model="orchDate"
              type="date"
              value-format="YYYY-MM-DD"
              placeholder="留空 = 明日"
              :disabled="orching"
            />
            <el-button :loading="orching" @click="runOrchestrate(true)">
              预演（只算不发）
            </el-button>
            <el-button type="primary" :loading="orching" @click="runOrchestrate(false)">
              确认发送
            </el-button>
          </div>
          <p class="send-window" :class="{ 'send-window--late': lateNight }">
            <span class="send-window__tag">{{ lateNight ? '深夜时段' : '建议时段' }}</span>
            <span>{{ sendWindowHint }}</span>
          </p>
          <el-alert
            v-if="orch"
            :type="orch.dryRun ? 'info' : 'success'"
            :closable="false"
            show-icon
            class="block"
          >
            <template #title>{{ orch.dryRun ? '预演结果（未发送）' : '发送结果' }}</template>
            <p class="block__text">{{ orchSummary(orch) }}</p>
            <ul v-if="orch.skipped.length" class="blockers">
              <li v-for="(s, i) in orch.skipped" :key="i">跳过 {{ s.count }} 条：{{ s.reason }}</li>
            </ul>
          </el-alert>
        </el-card>
      </el-tab-pane>
    </el-tabs>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  MessageReachView,
  MessageTemplateItemView,
  OrchestrateResult,
  fetchMessageReach,
  fetchMessageTemplates,
  initMessageTemplate,
  orchestrateMessage,
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

    // ⚠️ `id === null` = 该场景还没落库（生产不跑 seed，新场景必然如此）。
    // 此前这里直接弹「请先执行种子导入」—— 而运营没有执行种子的手段，
    // 等于新增场景永远配不了。改走落库端点，服务端按 scene 幂等处理。
    const r =
      t.id === null
        ? await initMessageTemplate(t.scene, patch)
        : await updateMessageTemplate(t.id, patch);
    ElMessage.success(r.note);
    await load();
  } catch {
    // 拦截器已统一提示；此处只需刷新，把服务端判定后的真实状态拉回来
    await load();
  } finally {
    saving.value = null;
  }
}

// ---------------------------------------------------------------- F5 到达率 + 编排

const tab = ref<'config' | 'reach'>('config');

const reachLoading = ref(false);
const reach = ref<MessageReachView | null>(null);
/** 区间；`null` = 尚未加载（由服务端回带后回填，见 `loadReach`） */
const range = ref<[string, string] | null>(null);

/**
 * 加载到达率
 *
 * ⚠️ **首次不传参**：让**服务端**决定默认区间（近 7 天），再把结果**回填** picker ——
 *    页面不自己算一套「近 7 天」。两端各算一次，在时区/边界不一致时会出现
 *    「picker 显示 9/19–9/25、数据其实是 9/18–9/24」而**没有任何一处报错**。
 * ⚠️ 回填只在 `range` 为空时做：否则「用户改区间 → 加载 → 回填 → 再触发 change」
 *    会变成一个自我触发的循环。
 */
async function loadReach(): Promise<void> {
  reachLoading.value = true;
  try {
    const q = range.value ? { from: range.value[0], to: range.value[1] } : {};
    const r = await fetchMessageReach(q);
    reach.value = r;
    if (!range.value) range.value = [r.range.from, r.range.to];
  } finally {
    reachLoading.value = false;
  }
}

/** 到达率文案：`null` → 「—」（**与「0%」区分** —— 0% 是发了全失败，「—」是没发过） */
function rateText(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : `${(v * 100).toFixed(1)}%`;
}

function wiringText(w: string): string {
  if (w === 'live') return '已接入投递';
  if (w === 'pending') return '一期无投递点';
  return '已下线场景';
}

const orching = ref(false);
const orch = ref<OrchestrateResult | null>(null);
const orchDate = ref('');

/**
 * 北京时间的当前小时（0–23）
 *
 * ⚠️ 刻意**不用** `new Date().getHours()`：那取的是浏览器本地时区，
 *    运营在境外或改过系统时区时会算错。用 UTC 偏移硬算，与业务时区（北京）恒定一致。
 */
function bjNowHour(): number {
  return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
}

/** 北京时间的 `HH:mm`（提示文案里给运营看「现在几点」） */
function bjNowText(): string {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/**
 * 深夜时段：22:00–06:59
 *
 * 为什么这不是「体验优化」而是**业务正误**：
 * 截单提醒的受众是「近 14 天下过单、明日尚未下单」的老客户，而截单时刻在 T-1 日 24:00。
 * 判据覆盖两段，原因不同：
 * · 22:00–23:59 距截单不足 2 小时 —— 多数人已休息，看到也来不及下单；
 * · 00:00–06:59 已过截单 —— 看到了也下不了单。
 * 共同后果：
 * ① 转化必然为 0，一次订阅额度（每人仅 1 条）白烧；
 * ② 吵醒的是最不该被吵的高频客户，属于纯负资产；
 * ③ 卡片上写着「截单时间 X 日 00:00」，次日早晨看到的人还会误以为「还早」。
 */
function isLateNight(hour: number): boolean {
  return hour >= 22 || hour < 7;
}

/**
 * 深夜不宜发送的原因（**按「是否已过截单」分开说**）
 *
 * ⚠️ 22:00–23:59 尚未截单，此时说「已过截单」就是错话 —— 一刀切会让提示自己变成假信息，
 *    运营一旦发现某条不对，其余几条也就都不信了。
 */
function lateNightReason(hour: number): string {
  return hour < 7
    ? '今日截单已过，对方看到了也下不了单，只会被吵醒，并白耗一次一次性订阅额度（每人仅 1 条）'
    : '距 0 点截单已不足 2 小时，而受众大多已休息 —— 这时候发，被看到也来不及下单，没被看到就是纯打扰';
}

/** 页面常驻的当前小时（每分钟刷新一次，页面开很久也不会停在旧值上） */
const nowHour = ref(bjNowHour());
const lateNight = computed(() => isLateNight(nowHour.value));
/** 分钟级刷新定时器（仅用于常驻提示；真发时的判定是现算的，不依赖它） */
let hourTimer: ReturnType<typeof setInterval> | null = null;

/** 建议发送窗口（截单提醒的业务节律） */
const SEND_WINDOW_TEXT = '17:00–20:00';

const sendWindowHint = computed(() => {
  if (lateNight.value) {
    return (
      `现在是 ${bjNowText()}：${lateNightReason(nowHour.value)}。` +
      `建议改到明天 ${SEND_WINDOW_TEXT}。`
    );
  }
  return (
    `建议 ${SEND_WINDOW_TEXT} 发送：用户还醒着、也还来得及下单。` +
    `截单在 0 点，深夜发出去只剩打扰。`
  );
});

/**
 * 触发一次编排（截单提醒）
 *
 * ⚠️ 真发（`dryRun=false`）**必须先二次确认**：服务端把 `dryRun` 缺省成 `true` 是
 *    安全默认，而真发这一次是**不可撤销的对外动作**（每条消耗一次用户订阅授权额度）。
 *    「预演」不弹确认 —— 它不产生任何外部影响。
 *
 * ⚠️ 深夜（22:00–06:59）加一道**强确认**：两种情形都该拦，但原因不同 ——
 *    22–24 点距 0 点截单已不足 2 小时（多数人已休息，看到了也来不及下单）；
 *    0–7 点则**已过截单**（看到了也下不了单）。两者都会白耗一次订阅额度。
 *    文案与按钮都改成劝阻向（「仍要发送／改到明天」），而不是中性的「确认／取消」。
 */
async function runOrchestrate(dryRun: boolean): Promise<void> {
  if (!dryRun) {
    /**
     * 现算一次，不复用 `nowHour`：页面可能从下午一直开到半夜，
     * 拿挂载时的小时数判断，恰好会放过真正该拦的那一次。
     */
    const hour = bjNowHour();
    const late = isLateNight(hour);
    try {
      await ElMessageBox.confirm(
        late
          ? `${bjNowText()} 已进入深夜时段：${lateNightReason(hour)}。` +
              `如非必要，请改到明天 ${SEND_WINDOW_TEXT}。仍要发送吗？`
          : '将向受众真实投递订阅消息（不可撤销，且每条消耗一次用户授权额度）。确认继续？',
        late ? '深夜发送确认' : '确认发送',
        late
          ? { type: 'error', confirmButtonText: '仍要发送', cancelButtonText: '改到明天' }
          : { type: 'warning', confirmButtonText: '确认发送', cancelButtonText: '取消' },
      );
    } catch {
      return; // 用户取消
    }
  }
  orching.value = true;
  try {
    orch.value = await orchestrateMessage({
      scene: 'cutoff_remind',
      audience: 'cutoff_remind_pending',
      mealDate: orchDate.value || undefined,
      dryRun,
    });
    ElMessage.success(orch.value.dryRun ? '预演完成（未发送）' : '编排完成');
    if (!dryRun) await loadReach();
  } catch {
    // 拦截器已统一提示；保留上一次结果不动
  } finally {
    orching.value = false;
  }
}

/** 编排结果摘要（把「一条没发出去」与「发失败了」分开说） */
function orchSummary(r: OrchestrateResult): string {
  const parts = [`目标发货日 ${r.mealDate}`, `受众 ${r.audienceSize} 人`];
  if (!r.dryRun) {
    parts.push(`投递 ${r.delivered} 条（成功 ${r.ok} / 失败 ${r.failed}）`);
  }
  if (r.truncated) parts.push(`注意：超出上限 ${r.limit}，本次只处理前 ${r.limit} 人`);
  return parts.join(' ｜ ');
}

onMounted(() => {
  void load();
  // 到达率也预载：切过去就有内容，而不是先看一片空白
  void loadReach();
  // 时段提示跨过 22:00 / 07:00 时自动翻面，不需要人手动刷新页面
  hourTimer = setInterval(() => {
    nowHour.value = bjNowHour();
  }, 60 * 1000);
});

onUnmounted(() => {
  if (hourTimer !== null) {
    clearInterval(hourTimer);
    hourTimer = null;
  }
});
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
  color: $c-warn-fg;
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
.form__stack {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form__hint {
  color: $c-text-weak;
  font-size: $fs-caption;
}
/* 发送时段提示：常规态中性、深夜态转警示色 —— 让「现在别发」在视觉上一眼可辨 */
.send-window {
  display: flex;
  align-items: baseline;
  gap: $space-1;
  margin: 0 0 $space-2;
  padding: $space-1 $space-2;
  border: 1px solid $c-mut-bd;
  border-radius: 4px;
  background: $c-mut-bg;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.6;
}
.send-window__tag {
  flex: none;
  font-weight: 600;
}
.send-window--late {
  border-color: $c-warn-bd;
  background: $c-warn-bg;
  /* 状态原色不作文字色（design:spec 第 3 条）—— 文字用加强档 $c-warn-fg */
  color: $c-warn-fg;
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
  color: $c-warn-fg;
  font-size: $fs-caption;
  line-height: 1.6;
}
// -------------------------------------------------------------- F5 到达率 + 编排
.tabs {
  margin-top: $space-2;
}
.table {
  margin-bottom: $space-2;
}
.sect {
  margin: $space-3 0 $space-2;
  font-weight: 600;
}
.hint {
  margin: 0 0 $space-2;
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.7;
}
</style>
