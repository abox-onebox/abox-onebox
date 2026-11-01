<template>
  <div class="page-container">
    <h2 class="page-container__title">企微令牌绑定</h2>
    <p class="page-container__meta">
      模块：P1-c · 接口：
      <code>GET / POST / DELETE /wecom/kb/bindings</code> ·
      <code>PATCH /wecom/kb/bindings/:userId/tier</code> · 数据源
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

    <div class="toolbar">
      <el-button v-if="canWrite" type="primary" @click="openCreate">
        <AbIcon name="plus" size="16" />
        新增绑定
      </el-button>
      <el-button :loading="loading" @click="load">刷新</el-button>
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
      <el-table-column label="操作" width="300" fixed="right">
        <template #default="{ row }">
          <el-button v-if="canWrite" link type="primary" @click="openEdit(asRow(row))">
            编辑
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
  removeWecomBinding,
  setWecomBindingTier,
  upsertWecomBinding,
  type WecomBindingRow,
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
</style>
