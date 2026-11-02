<template>
  <div class="page-container">
    <h2 class="page-container__title">企微令牌绑定</h2>
    <p class="page-container__meta">
      模块：P1-c · 接口：
      <code>GET / POST / DELETE /admin/wecom-kb/bindings</code> ·
      <code>PATCH /admin/wecom-kb/bindings/:userId/tier</code> ·
      <code>PATCH /admin/wecom-kb/bindings/:userId/grant</code> ·
      <code>GET /admin/wecom-kb/ops</code> · 数据源
      <code>ab_wecom_binding</code>
    </p>

    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>令牌只进不出。</b>
        列表与详情<b>不回显令牌明文</b>，只给「已配置 / 未配置」标记 ——
        一旦录入，页面上再也读不回原文，只能重新粘贴覆盖。
      </template>
    </el-alert>
    <el-alert type="warning" :closable="false" class="note">
      <template #title>
        <b>留空 = 不修改</b>，清空是<b>另一个动作</b>（要显式点「清空」）。
        两者在服务端靠「字段不传」与「传空串」区分 —— 把空输入框当空串提交，会在你什么都没填的
        情况下把线上令牌清掉。
      </template>
    </el-alert>
    <el-alert type="warning" :closable="false" class="note">
      <template #title>
        <b>身份等级决定这个人能让机器人做多少事。</b>
        <b>负责人</b>＝后台 <code>admin</code> 角色，<b>全部功能</b>（含动钱、动单、改团长）；
        <b>同事</b>＝<code>operator</code> 角色，只能做查单、改菜品等日常操作。
        <b>新增绑定默认是「同事」</b>（最小权限），要提权请点行内「设为负责人」。
      </template>
    </el-alert>
    <el-alert type="success" :closable="false" class="note">
      <template #title>
        <b>要给同事开一两项敏感功能，用「单独特批」，别用「设为负责人」。</b>
        提权是<b>整体</b>给（131 项全开，含改佣金、动账）；单独特批只把<b>你勾中的那几件</b>给他，
        其余照旧。比如财务同事只要「退款审批」，就只勾那一条。
        <b>清空勾选 = 收回</b>，他退回原本能力，不会因此做不了事。
      </template>
    </el-alert>

    <div class="toolbar">
      <el-button v-if="canWrite" type="primary" @click="openCreate">
        <AbIcon name="plus" size="16" />
        新增绑定
      </el-button>
      <el-button :loading="loading" @click="load">刷新</el-button>
      <el-button v-if="canWrite" @click="openSim">试一句（机器人试跑）</el-button>
      <span v-if="!canWrite" class="dialog__tip">只读：绑定 / 解绑需要 super_admin / admin</span>
    </div>

    <el-table v-loading="loading" :data="rows" border size="small">
      <el-table-column label="企微 userid" min-width="180">
        <template #default="{ row }">{{ asRow(row).userId }}</template>
      </el-table-column>
      <el-table-column label="操作人名" min-width="140">
        <template #default="{ row }">{{ asRow(row).operatorName || '—' }}</template>
      </el-table-column>
      <el-table-column label="身份等级" width="150">
        <template #default="{ row }">
          <el-tag size="small" :type="asRow(row).tier === 'owner' ? 'danger' : 'info'">
            {{ tierLabel(asRow(row).tier) }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="单独特批" width="120">
        <template #default="{ row }">
          <!-- owner 本来全通，特批对他没有意义，显式说明比给个空标签清楚 -->
          <span v-if="asRow(row).tier === 'owner'" class="dialog__tip">全通，无需</span>
          <el-tag v-else size="small" :type="grantCount(row) > 0 ? 'warning' : 'info'">
            {{ grantCount(row) > 0 ? grantCount(row) + ' 项' : '无' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作令牌" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="asRow(row).hasOperatorToken ? 'success' : 'info'">
            {{ asRow(row).hasOperatorToken ? '已配置' : '未配置' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="审批令牌" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="asRow(row).hasApproverToken ? 'success' : 'info'">
            {{ asRow(row).hasApproverToken ? '已配置' : '未配置' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="更新时间" width="160">
        <template #default="{ row }">{{ formatDateTime(asRow(row).updatedAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="400" fixed="right">
        <template #default="{ row }">
          <el-button v-if="canWrite" link type="primary" @click="openEdit(asRow(row))">
            编辑
          </el-button>
          <!-- ⭐ 单独特批：按功能项给，不动身份、不动令牌 -->
          <el-button
            v-if="canWrite && asRow(row).tier !== 'owner'"
            link
            type="primary"
            @click="openGrant(asRow(row))"
          >
            特批功能
          </el-button>
          <!-- ⭐ 放权 / 收回：只改 tier 一列，不动令牌、不动人名 -->
          <el-button
            v-if="canWrite"
            link
            :type="asRow(row).tier === 'owner' ? 'warning' : 'success'"
            @click="onToggleTier(asRow(row))"
          >
            {{ asRow(row).tier === 'owner' ? '收回为同事' : '设为负责人' }}
          </el-button>
          <el-button
            v-if="canWrite"
            link
            type="warning"
            :disabled="!asRow(row).hasOperatorToken && !asRow(row).hasApproverToken"
            @click="onClearTokens(asRow(row))"
          >
            清空令牌
          </el-button>
          <el-button v-if="canWrite" link type="danger" @click="onRemove(asRow(row))">
            解绑
          </el-button>
          <span v-if="!canWrite" class="dialog__tip">—</span>
        </template>
      </el-table-column>
      <template #empty>
        <span class="dialog__tip">暂无绑定 —— 同事在企微里发的指令将全部走「无令牌」分支</span>
      </template>
    </el-table>

    <p class="footnote">
      提示：<b>解绑</b>是物理删除整行（两个令牌一起没）；<b>清空令牌</b>保留这条绑定，
      只把两个令牌置空，便于保留 userid 与人名下次直接粘贴。
      <b>收回为同事</b>只降级身份，令牌和人名都不动 —— 收回后这个人还能用机器人查单，
      但动不了钱、动不了单。
    </p>

    <!-- ─────────────── 新增 / 编辑 ─────────────── -->
    <el-dialog
      v-model="dialogVisible"
      :title="isEdit ? '编辑绑定' : '新增绑定'"
      width="520"
      :close-on-click-modal="false"
    >
      <el-form label-width="110px">
        <el-form-item label="企微 userid" required>
          <el-input
            v-model="form.userId"
            maxlength="64"
            :disabled="isEdit"
            placeholder="企微通讯录里的 userid"
          />
          <div v-if="isEdit" class="dialog__tip">userid 是主键，不可改 —— 要换请先解绑再新增。</div>
        </el-form-item>
        <el-form-item label="操作人名" required>
          <el-input
            v-model="form.operatorName"
            maxlength="64"
            placeholder="用于操作日志展示的人名"
          />
        </el-form-item>
        <el-form-item label="操作令牌">
          <el-input
            v-model="form.operatorToken"
            type="password"
            show-password
            maxlength="512"
            :placeholder="tokenPlaceholder(rowRef?.hasOperatorToken ?? false)"
          />
        </el-form-item>
        <el-form-item label="审批令牌">
          <el-input
            v-model="form.approverToken"
            type="password"
            show-password
            maxlength="512"
            :placeholder="tokenPlaceholder(rowRef?.hasApproverToken ?? false)"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>

    <!-- ─────────────── 单独特批（按功能项放权）─────────────── -->
    <el-drawer
      v-model="grantVisible"
      :title="`特批功能 · ${grantRow?.operatorName || grantRow?.userId || ''}`"
      size="720px"
      :close-on-click-modal="false"
    >
      <div v-loading="opsLoading" class="grant">
        <el-alert type="info" :closable="false" class="note">
          <template #title>
            勾中的项<b>额外</b>允许他做；<b>不勾 = 收回</b>（他退回原本能力，不会做不了事）。
            列表里标「本来就会」的是 <code>operator</code> 角色本来就能做的事，
            <b>勾了也不会多给</b>，只为让你看清边界。
          </template>
        </el-alert>

        <div class="grant__bar">
          <el-select
            v-model="grantModule"
            placeholder="全部模块"
            clearable
            size="small"
            class="grant__module"
          >
            <el-option v-for="m in grantModules" :key="m" :label="m" :value="m" />
          </el-select>
          <el-input
            v-model="grantKeyword"
            size="small"
            clearable
            placeholder="搜功能名 / 路径"
            class="grant__kw"
          />
          <span class="grant__count">已勾 {{ grantPicked.length }} 项</span>
          <el-button size="small" text type="danger" @click="grantPicked = []">清空勾选</el-button>
        </div>

        <el-table :data="grantShown" border size="small" height="calc(100vh - 300px)">
          <el-table-column width="46">
            <template #default="{ row }">
              <!-- 本来就会的项禁用勾选：勾了没意义，还会让「放权 N 项」这个数虚高 -->
              <el-checkbox
                :model-value="grantPicked.includes(asOp(row).code)"
                :disabled="asOp(row).staffBase"
                @change="(v) => toggleGrant(asOp(row).code, v)"
              />
            </template>
          </el-table-column>
          <el-table-column label="功能" min-width="220">
            <template #default="{ row }">
              <span>{{ asOp(row).label }}</span>
              <el-tag v-if="asOp(row).staffBase" size="small" type="info" class="grant__tag">
                本来就会
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="模块" width="120">
            <template #default="{ row }">{{ asOp(row).module }}</template>
          </el-table-column>
          <el-table-column label="影响" width="130">
            <template #default="{ row }">
              <el-tag size="small" :type="riskTagType(asOp(row).risk)">
                {{ riskLabel(asOp(row).risk) }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="接口" min-width="200">
            <template #default="{ row }">
              <code class="grant__path">{{ asOp(row).method }} {{ asOp(row).path }}</code>
            </template>
          </el-table-column>
        </el-table>

        <p class="footnote">
          提示：勾中「动钱 / 动单 / 动权」类功能时，机器人执行前仍会给出草稿让你确认；<br />
          但<b>机器人会以负责人身份代为执行</b>（后台 <code>@Roles</code> 只认角色，不认人），
          所以这里勾一项=<b>真给他这项能力</b>，请按需最小化。
        </p>
      </div>
      <template #footer>
        <el-button @click="grantVisible = false">取消</el-button>
        <el-button type="primary" :loading="grantSaving" @click="submitGrant">保存特批</el-button>
      </template>
    </el-drawer>

    <!-- ─────────────── 机器人试跑 ─────────────── -->
    <el-drawer v-model="simVisible" title="机器人试跑" size="560px">
      <div class="sim">
        <el-alert type="warning" :closable="false" class="note">
          <template #title>
            <b>这里会真的写库。</b>它不是沙箱 —— 写操作仍要「回 1」才执行，但点了就是真执行。
            判据与线上同一套，所以跑通 = 企微通了就能用。审计里记的是<b>你的姓名</b>。
          </template>
        </el-alert>

        <!-- 身份档：只以负责人跑，就证明不了「同事放权后能做什么」 -->
        <div class="sim__id">
          <span class="sim__id-label">以谁的身份</span>
          <el-radio-group v-model="simTier" size="small" @change="switchSimIdentity">
            <el-radio-button label="owner">负责人 · 全功能</el-radio-button>
            <el-radio-button label="staff">同事 · 仅其本职</el-radio-button>
          </el-radio-group>
        </div>

        <el-select
          v-if="simTier === 'staff'"
          v-model="simGranted"
          multiple
          filterable
          clearable
          size="small"
          class="sim__grant"
          placeholder="可选：额外特批几项（模拟放权给他）"
          @change="switchSimIdentity"
        >
          <el-option
            v-for="o in simGrantOptions"
            :key="o.code"
            :label="`${o.label}（${o.module}）`"
            :value="o.code"
          />
        </el-select>

        <p v-if="simTier === 'staff'" class="dialog__tip sim__grant-tip">
          <template v-if="simGranted.length === 0">
            不放权 = 同事真实的本职能力（他越权的话这里会如实说「做不了」）。
          </template>
          <template v-else>
            勾了 {{ simGranted.length }} 项 ⇒ 这几项会被<b>以负责人身份</b>代执行（后台只认角色，
            不认人），清单之外的仍然做不了。
          </template>
        </p>

        <div class="sim__log">
          <div v-if="simLog.length === 0" class="dialog__tip">
            试试发「操作目录」「看 orders」「找 退款」「帮助」。
          </div>
          <div
            v-for="(m, i) in simLog"
            :key="i"
            :class="['sim__msg', m.role === 'me' ? 'sim__msg--me' : 'sim__msg--bot']"
          >
            <pre class="sim__text">{{ m.text }}</pre>
          </div>
        </div>

        <div class="sim__bar">
          <el-input
            v-model="simInput"
            placeholder="像在企微里那样说一句话"
            maxlength="500"
            :disabled="simBusy"
            @keyup.enter="sendSim"
          />
          <el-button type="primary" :loading="simBusy" @click="sendSim">发送</el-button>
          <el-button :disabled="simBusy" @click="resetSim">清空会话</el-button>
        </div>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
/**
 * 企微令牌绑定（补 admin:coverage 扫出的缺口 #44）
 *
 * ⭐ 为什么必须做后台入口：绑定是「同事在企微里发指令能不能生效」的总闸。
 *    此前三个端点全在、后台零页面 ⇒ 要加人只能改库，且没人知道现在绑了谁。
 *
 * ⭐ 令牌的两个「空」必须分开（本页最容易踩的坑）：
 *      · 字段**不传**  → 服务端 `??` 落回原值（不改）
 *      · 字段传 **''** → 真的写空串（清空）
 *    一个空输入框在直觉上等于「我没改」，若被无脑 `''` 提交就是把线上令牌悄悄清空。
 *    ⇒ 本页：**留空 = 不修改**（提交时裁剪掉空串字段），清空走独立按钮。
 *
 * ⭐ 令牌不回显是**服务端**决定的（list 只回 hasXxx 标记），端上顺势也不做「显示原文」，
 *    不做「点一下复制到剪贴板」—— 页面能读到的令牌，迟早会出现在截图里。
 */
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  fetchWecomBindings,
  fetchWecomOps,
  removeWecomBinding,
  setWecomBindingGrant,
  setWecomBindingTier,
  simulateWecomChat,
  upsertWecomBinding,
  type WecomBindingRow,
  type WecomOpItem,
  type WecomTier,
} from '@/api/system';
import { useAuthStore } from '@/stores/auth';
import { formatDateTime } from '@/utils/format';

const auth = useAuthStore();
/** 真正的越权闸门是后端 `@Roles('super_admin','admin')`，这里只做按钮显隐（同 op-blocklist） */
const canWrite = computed(() => auth.role === 'super_admin' || auth.role === 'admin');

const loading = ref(false);
const saving = ref(false);
const rows = ref<WecomBindingRow[]>([]);
const dialogVisible = ref(false);
const isEdit = ref(false);
/** 编辑中的原行（用于「已配置 / 未配置」占位提示） */
const rowRef = ref<WecomBindingRow | null>(null);

const form = ref({ userId: '', operatorName: '', operatorToken: '', approverToken: '' });

/** el-table 插槽的 row 是宽松 DefaultRow，入口断言一次（同 op-blocklist / supplier/list） */
function asRow(raw: unknown): WecomBindingRow {
  return raw as WecomBindingRow;
}

/**
 * 占位提示必须区分「已有 / 没有」——
 * 已有令牌时留空表示「不动它」，没有时留空表示「仍然没有」；两句话不能写成一句。
 */
function tokenPlaceholder(has: boolean): string {
  return has ? '已配置 · 留空表示不修改' : '未配置 · 留空表示不填';
}

/** 等级文案的唯一出口 —— 表格与确认框共用，避免两处各写一份中文 */
function tierLabel(tier: WecomTier): string {
  return tier === 'owner' ? '负责人 · 全功能' : '同事 · 受限';
}

// ─────────────────── 单独特批（按功能项放权）───────────────────
const grantVisible = ref(false);
const grantRow = ref<WecomBindingRow | null>(null);
const opsLoading = ref(false);
const grantSaving = ref(false);
const grantOps = ref<WecomOpItem[]>([]);
const grantPicked = ref<string[]>([]);
const grantModule = ref<string>('');
const grantKeyword = ref<string>('');

function asOp(raw: unknown): WecomOpItem {
  return raw as WecomOpItem;
}

/** 列表里显示「特批 N 项」；owner 不计（他本来全通） */
function grantCount(raw: unknown): number {
  const r = asRow(raw);
  return r.tier === 'owner' ? 0 : (r.grantedOps ?? []).length;
}

const grantModules = computed(() => [...new Set(grantOps.value.map((o) => o.module))].sort());

/**
 * 抽屉里显示哪些项。
 *
 * ⚠️ 这里**不**过滤掉「本来就会」的项，只把它标出来并禁用勾选：
 *    管理者要判断「要不要给他开退款审批」，前提是能看见「他现在已有什么」。
 *    只显示可放权项会让人误以为他什么都没有，越给越多。
 */
const grantShown = computed(() => {
  const kw = grantKeyword.value.trim().toLowerCase();
  return grantOps.value.filter((o) => {
    if (grantModule.value && o.module !== grantModule.value) return false;
    if (!kw) return true;
    return (
      o.label.toLowerCase().includes(kw) ||
      o.path.toLowerCase().includes(kw) ||
      o.code.toLowerCase().includes(kw)
    );
  });
});

function riskLabel(risk: WecomOpItem['risk']): string {
  return risk === 'high' ? '动钱/动单/动权' : risk === 'mid' ? '改数据' : '只读';
}

function riskTagType(risk: WecomOpItem['risk']): 'danger' | 'warning' | 'info' {
  return risk === 'high' ? 'danger' : risk === 'mid' ? 'warning' : 'info';
}

async function openGrant(row: WecomBindingRow): Promise<void> {
  grantRow.value = row;
  grantPicked.value = [...(row.grantedOps ?? [])];
  grantModule.value = '';
  grantKeyword.value = '';
  grantVisible.value = true;
  // 目录只在首次打开时拉一次（静态数据）；与试跑台共用同一个加载器
  await ensureOps();
}

/**
 * 勾选 / 取消勾选一项。
 *
 * `checked` 收 `unknown` 而不是 `boolean`：Element Plus 的 `checkbox.change` 回调
 * 实际类型是 `CheckboxValueType`（`boolean | string | number`），标注成 `boolean`
 * 会编译不过。非 group 场景下实参就是 boolean，故用 truthiness 归一即可
 * （不写 `Boolean(checked)` —— eslint 的 `no-extra-boolean-cast` 会判冗余）。
 */
function toggleGrant(code: string, checked: unknown): void {
  const set = new Set(grantPicked.value);
  if (checked) set.add(code);
  else set.delete(code);
  grantPicked.value = [...set];
}

async function submitGrant(): Promise<void> {
  const row = grantRow.value;
  if (!row) return;
  const ops = grantPicked.value;
  const who = row.operatorName || row.userId;

  // 勾了高危项必须二次确认：这一步等于「以负责人身份替他做」，不是普通配置
  const high = grantOps.value.filter((o) => ops.includes(o.code) && o.risk === 'high');
  if (high.length > 0) {
    const names = high
      .slice(0, 5)
      .map((o) => o.label)
      .join('、');
    try {
      await ElMessageBox.confirm(
        `你给 ${who} 开了 ${high.length} 项「动钱/动单/动权」功能：${names}${
          high.length > 5 ? ' 等' : ''
        }。\n机器人会以负责人身份替 TA 执行，等于真把这几项能力给了他。确认？`,
        '确认开放高危功能',
        { type: 'warning', confirmButtonText: '确认开放', cancelButtonText: '再想想' },
      );
    } catch {
      return;
    }
  }

  grantSaving.value = true;
  try {
    const r = await setWecomBindingGrant(row.userId, ops);
    if (!r?.found) {
      ElMessage.warning('这条绑定已不存在（可能刚被解绑），请刷新列表');
      grantVisible.value = false;
      await load();
      return;
    }
    // ⭐ 服务端会剔掉目录里已失效的编码；不提示的话管理员会以为「全保存成功了」
    const unknown = r.unknown ?? [];
    if (unknown.length > 0) {
      ElMessage.warning(
        `已保存 ${r.count ?? 0} 项，但有 ${unknown.length} 项在功能目录里已不存在、被忽略：${unknown
          .slice(0, 3)
          .join('、')}${unknown.length > 3 ? ' 等' : ''}`,
      );
    } else {
      ElMessage.success(
        ops.length > 0
          ? `已给 ${who} 特批 ${r.count ?? ops.length} 项`
          : `已收回 ${who} 的全部特批`,
      );
    }
    grantVisible.value = false;
    await load();
  } finally {
    grantSaving.value = false;
  }
}

async function load(): Promise<void> {
  loading.value = true;
  try {
    rows.value = (await fetchWecomBindings()) ?? [];
  } finally {
    loading.value = false;
  }
}

function openCreate(): void {
  isEdit.value = false;
  rowRef.value = null;
  form.value = { userId: '', operatorName: '', operatorToken: '', approverToken: '' };
  dialogVisible.value = true;
}

function openEdit(row: WecomBindingRow): void {
  isEdit.value = true;
  rowRef.value = row;
  // ⚠️ 令牌**从不回填**（服务端也不给原文）：两个输入框留空 = 本次不修改
  form.value = {
    userId: row.userId,
    operatorName: row.operatorName,
    operatorToken: '',
    approverToken: '',
  };
  dialogVisible.value = true;
}

async function submit(): Promise<void> {
  const userId = form.value.userId.trim();
  const operatorName = form.value.operatorName.trim();
  if (!userId) {
    ElMessage.warning('企微 userid 必填');
    return;
  }
  if (!operatorName) {
    ElMessage.warning('操作人名必填（会出现在操作日志里）');
    return;
  }

  // ⭐ 关键：空串一律**不传**（= 不修改）。要清空走 onClearTokens，那里显式传 ''。
  //    写成 `operatorToken: form.value.operatorToken` 会把「没填」变成「清空」。
  const payload: Parameters<typeof upsertWecomBinding>[0] = { userId, operatorName };
  const op = form.value.operatorToken.trim();
  const ap = form.value.approverToken.trim();
  if (op) payload.operatorToken = op;
  if (ap) payload.approverToken = ap;

  saving.value = true;
  try {
    await upsertWecomBinding(payload);
    ElMessage.success(isEdit.value ? '已保存（令牌未改动，除非你填了新值）' : '已新增绑定');
    dialogVisible.value = false;
    await load();
  } finally {
    saving.value = false;
  }
}

/** 清空两个令牌（保留绑定行）· 显式传空串 —— 与「留空不传」正是相反的两条路 */
async function onClearTokens(row: WecomBindingRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `将清空 ${row.operatorName || row.userId} 的操作令牌与审批令牌，绑定本身保留。确认清空？`,
      '确认清空令牌',
      { type: 'warning', confirmButtonText: '确认清空', cancelButtonText: '再想想' },
    );
  } catch {
    return;
  }
  await upsertWecomBinding({
    userId: row.userId,
    operatorName: row.operatorName,
    operatorToken: '',
    approverToken: '',
  });
  ElMessage.success('令牌已清空（绑定保留）');
  await load();
}

/**
 * 放权 / 收回 —— 只改 `tier` 一列
 *
 * ⚠️ 走独立端点而不是复用「编辑」弹窗：编辑弹窗是**整行覆盖式保存**，
 *    而放权只是一个意图。若借道编辑，用户点「设为负责人」时若弹窗里令牌框恰好
 *    有残留内容，就会顺手改掉令牌 —— 两件事不该共用一个提交路径。
 * ⚠️ 提权（staff→owner）要求二次确认并写清后果：这是**从受限到全权**的一步，
 *    确认文案必须点名「可以动钱、动单」；降权只是收敛权限，问一句即可，不必吓人。
 */
async function onToggleTier(row: WecomBindingRow): Promise<void> {
  const next: WecomTier = row.tier === 'owner' ? 'staff' : 'owner';
  const who = row.operatorName || row.userId;
  const message =
    next === 'owner'
      ? `把 ${who} 提为「负责人」后，TA 在企微里能让机器人操作后台全部功能 —— 包括退款审批、改单、改团长佣金、批量发券。确认提权？`
      : `把 ${who} 收回为「同事」后，TA 仍可查单、改菜品等日常操作，但动不了钱、动不了单。确认收回？`;
  try {
    await ElMessageBox.confirm(message, next === 'owner' ? '确认提权' : '确认收回', {
      type: 'warning',
      confirmButtonText: next === 'owner' ? '确认提权' : '确认收回',
      cancelButtonText: '再想想',
    });
  } catch {
    return;
  }
  const r = await setWecomBindingTier(row.userId, next);
  if (!r?.found) {
    // ⭐ 服务端刻意不静默成功：绑定可能已被别人解绑，此时不能提示「已保存」
    ElMessage.warning('这条绑定已不存在（可能刚被解绑），请刷新列表');
    await load();
    return;
  }
  ElMessage.success(next === 'owner' ? `已设为负责人：${who}` : `已收回为同事：${who}`);
  await load();
}

/** 解绑（物理删除整行）· 与「清空令牌」的区别必须写在确认文案里，否则用户分不清 */
async function onRemove(row: WecomBindingRow): Promise<void> {
  try {
    await ElMessageBox.confirm(
      `解绑后 ${row.operatorName || row.userId} 在企微里的指令将不再生效（需重新绑定）。确认解绑？`,
      '确认解绑',
      { type: 'warning', confirmButtonText: '确认解绑', cancelButtonText: '再想想' },
    );
  } catch {
    return;
  }
  await removeWecomBinding(row.userId);
  ElMessage.success('已解绑');
  await load();
}

// ─────────────────── 机器人试跑 ───────────────────
/**
 * 为什么这个页面要有试跑：企微回调要域名、备案没过 ⇒ 机器人在真实环境里
 * 一次都没被跑通过。没有它，「能操作全部功能」只是个没人验证过的说法。
 */
interface SimMsg {
  role: 'me' | 'bot';
  text: string;
}

const simVisible = ref(false);
const simInput = ref('');
const simBusy = ref(false);
const simLog = ref<SimMsg[]>([]);
/** 以谁的身份跑：默认负责人（最常用）；切到同事才能验「放权到底生效没」 */
const simTier = ref<WecomTier>('owner');
/** 同事档的额外特批（与真实绑定同一语义：加号 —— 只多给这几项） */
const simGranted = ref<string[]>([]);

/**
 * 特批可选项：只列「同事本来做不了」的项。
 *
 * 与特批抽屉不同 —— 那里必须把「本来就会」的也列出来（管理者要看清他现在有什么边界），
 * 这里只是模拟，勾了不会改变任何结论，只会让下拉更长，故过滤掉。
 */
const simGrantOptions = computed(() => grantOps.value.filter((o) => !o.staffBase));

/** 目录只在首次打开时拉一次：它是静态的（随部署变，不随操作变） */
async function ensureOps(): Promise<void> {
  if (grantOps.value.length > 0) return;
  opsLoading.value = true;
  try {
    const r = await fetchWecomOps();
    grantOps.value = r?.items ?? [];
  } finally {
    opsLoading.value = false;
  }
}

function openSim(): void {
  simVisible.value = true;
  void ensureOps();
}

async function sendSim(): Promise<void> {
  const text = simInput.value.trim();
  if (!text || simBusy.value) return;
  simLog.value.push({ role: 'me', text });
  simInput.value = '';
  simBusy.value = true;
  try {
    const r = await simulateWecomChat(text, {
      tier: simTier.value,
      grantedOps: simGranted.value,
    });
    // 死编码要当场说：不然「勾了 3 项、只生效 2 项」会被当成机器人算错
    const dead = r?.unknown ?? [];
    if (dead.length > 0) {
      simLog.value.push({
        role: 'bot',
        text: `（已忽略 ${dead.length} 项在功能目录里不存在的编码：${dead.slice(0, 3).join('、')}）`,
      });
    }
    simLog.value.push({ role: 'bot', text: r?.reply ?? '（后台没有回复内容）' });
  } finally {
    simBusy.value = false;
  }
}

/**
 * 切身份 = 换一个会话。
 *
 * 服务端按「管理员 + 身份档 + 清单指纹」分会话，切过去本来就是新会话；
 * 这里再显式清一次并清屏，是为了不把两个身份的对话混在同一屏 ——
 * 混着看最容易得出错结论（「同事也能退款？」其实上一句是负责人问的）。
 */
async function switchSimIdentity(): Promise<void> {
  simLog.value = [];
  try {
    await simulateWecomChat('取消', {
      reset: true,
      tier: simTier.value,
      grantedOps: simGranted.value,
    });
  } catch {
    // 清会话失败不挡住试用：真正的错误（执行账号没配好等）会在发第一句时如实回显
  }
}

/** 清空会话 = 服务端把「取消」当一句话处理（复用机器人的取消语义，不另开端点） */
async function resetSim(): Promise<void> {
  simBusy.value = true;
  try {
    await simulateWecomChat('取消', {
      reset: true,
      tier: simTier.value,
      grantedOps: simGranted.value,
    });
    simLog.value = [];
    ElMessage.success('会话已清空');
  } finally {
    simBusy.value = false;
  }
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

.footnote {
  margin-top: $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.grant {
  display: flex;
  flex-direction: column;
  gap: $space-2;
}

.grant__bar {
  display: flex;
  align-items: center;
  gap: $space-2;
}

.grant__module {
  width: 160px;
}

.grant__kw {
  width: 220px;
}

.grant__count {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.grant__tag {
  margin-left: $space-2;
}

.grant__path {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.sim {
  display: flex;
  flex-direction: column;
  gap: $space-2;
  height: 100%;
}

.sim__id {
  display: flex;
  align-items: center;
  gap: $space-2;
}

.sim__id-label {
  color: $c-text-weak;
  font-size: $fs-caption;
}

.sim__grant {
  width: 100%;
}

.sim__grant-tip {
  margin: 0;
}

.sim__log {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: $space-2;
  padding: $space-2 0;
  min-height: 320px;
}

.sim__msg {
  max-width: 86%;
}

.sim__msg--me {
  align-self: flex-end;
}

.sim__msg--bot {
  align-self: flex-start;
}

.sim__text {
  margin: 0;
  padding: $space-2;
  border-radius: $radius-md;
  font-family: inherit;
  font-size: $fs-body;
  white-space: pre-wrap;
  word-break: break-word;
  background: $c-surface-2;
  color: $c-text;
}

.sim__msg--me .sim__text {
  background: $c-gold-bg;
}

.sim__bar {
  display: flex;
  gap: $space-2;
  align-items: center;
}
</style>
