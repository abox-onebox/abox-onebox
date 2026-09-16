<template>
  <div class="page-container">
    <h2 class="page-container__title">团长管理 · 名录（C2 四级分佣）</h2>
    <p class="page-container__meta">
      模块：M33-03/04 · 原型 P32 · 接口：D19 名录 / D20 任命与转交 / D21 常规变更 / D22 资质补录 ·
      数据源 <code>ab_team_leader</code> + <code>ab_leader_invite</code>（手机号脱敏）
    </p>

    <!-- C3 口径：避免运营一直在等一个并不存在的「审核队列」 -->
    <el-alert type="info" :closable="false" class="note">
      <template #title>
        <b>C3 口径：团长申请即生效，没有人工审核</b> —— 用户在 App
        填微信号、手机号、办公楼后<b>立即成为见习团长（8%）</b>。 本页「待审核」恒为 0
        是<b>口径表达</b>，不是没做。发现恶意申请请用「例外处理 → 停用」。
      </template>
    </el-alert>

    <!-- ─────────────── 汇总（按当前过滤条件的全量，不受分页影响） ─────────────── -->
    <div class="stats">
      <div class="stats__item">
        <span class="stats__label">团长总数</span>
        <span class="stats__value">{{ summary.totalCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">在职 / 停职</span>
        <span class="stats__value">
          {{ summary.activeCount }}
          <span class="stats__sub">/ {{ summary.suspendedCount }}</span>
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">本月新增</span>
        <span class="stats__value">{{ summary.monthNewCount }}</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">待审核申请</span>
        <span class="stats__value stats__value--muted">0</span>
      </div>
      <div class="stats__item">
        <span class="stats__label">本月佣金支出</span>
        <span class="stats__value stats__value--warn">
          {{ fenToCny(summary.monthCommissionFen) }}
        </span>
      </div>
      <div class="stats__item">
        <span class="stats__label">等级分布</span>
        <span class="stats__value stats__value--small">
          见习 {{ summary.traineeCount }} · 正式 {{ summary.formalCount }} · 金牌
          {{ summary.goldCount }} · 首席 {{ summary.chiefCount }}
        </span>
      </div>
    </div>

    <!-- ─────────────── 工具条 ─────────────── -->
    <div class="toolbar">
      <el-select
        v-model="query.groupId"
        placeholder="楼群"
        clearable
        style="width: 160px"
        @change="onGroupChange"
      >
        <el-option v-for="g in options.groups" :key="g.id" :label="g.name" :value="g.id" />
      </el-select>

      <el-select v-model="query.buildingId" placeholder="办公楼" clearable style="width: 180px">
        <el-option
          v-for="b in buildingChoices"
          :key="b.id"
          :label="b.name"
          :value="b.id"
          :disabled="b.status !== 1"
        />
      </el-select>

      <el-select v-model="query.level" placeholder="等级" clearable style="width: 130px">
        <el-option
          v-for="l in options.levels"
          :key="l.key"
          :label="`${l.label}（${l.rateText}）`"
          :value="l.key"
        />
      </el-select>

      <el-select v-model="query.status" placeholder="在职状态" clearable style="width: 120px">
        <el-option v-for="s in options.statuses" :key="s.key" :label="s.label" :value="s.key" />
      </el-select>

      <el-input
        v-model="query.keyword"
        placeholder="姓名 / 手机号 / 微信昵称"
        clearable
        style="width: 200px"
        @keyup.enter="reload"
        @clear="reload"
      />

      <div class="toolbar__right">
        <el-button :loading="loading" @click="reload()">查询</el-button>
        <el-button @click="goApplications">申请流水</el-button>
        <el-tooltip
          :disabled="canManage"
          content="仅管理员 / 超级管理员可任命团长（决定谁拿哪个楼的佣金）"
          placement="top"
        >
          <span>
            <el-button type="primary" :disabled="!canManage" @click="openAppoint()">
              任命 / 转交团长
            </el-button>
          </span>
        </el-tooltip>
      </div>
    </div>

    <!-- ─────────────── 名录 ─────────────── -->
    <el-table v-loading="loading" :data="rows" class="table" stripe>
      <el-table-column label="团长" min-width="150">
        <template #default="{ row }">
          <div class="stack">
            <span class="strong">{{ asRow(row).realName }}</span>
            <span class="stack__sub mono">{{ displayOr(asRow(row).phoneMasked) }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="等级 / 费率" width="130">
        <template #default="{ row }">
          <div class="stack">
            <el-tag size="small" :type="levelTagType(asRow(row).level)">
              {{ asRow(row).levelLabel }}
            </el-tag>
            <span class="stack__sub">{{ asRow(row).commissionRateText }}</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="服务办公楼" min-width="180">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ displayOr(asRow(row).buildingName) }}</span>
            <span class="stack__sub">
              {{ displayOr(asRow(row).groupName) }} ·
              {{ displayOr(asRow(row).floor) }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="月单 / 推荐" width="110">
        <template #default="{ row }">
          <div class="stack">
            <span>{{ asRow(row).monthOrders }} 单</span>
            <span class="stack__sub">{{ asRow(row).invitedFormalCount }} 名转正</span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="余额 / 累计佣金" min-width="150">
        <template #default="{ row }">
          <div class="stack">
            <span>余额 {{ fenToCny(asRow(row).balanceFen) }}</span>
            <span class="stack__sub"> 累计 {{ fenToCny(asRow(row).totalCommissionFen) }} </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="收款方式" width="100">
        <template #default="{ row }">
          <el-tag v-if="asRow(row).payoutBound" size="small" type="success">已绑定</el-tag>
          <el-tooltip v-else content="未绑定收款方式，提现会被 40007 拦下" placement="top">
            <el-tag size="small" type="warning">未绑定</el-tag>
          </el-tooltip>
        </template>
      </el-table-column>

      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="asRow(row).status === 1 ? 'success' : 'info'">
            {{ asRow(row).statusLabel }}
          </el-tag>
        </template>
      </el-table-column>

      <el-table-column label="协议留痕" min-width="140">
        <template #default="{ row }">
          <div class="stack">
            <span class="stack__sub">
              {{ asRow(row).agreeVersion ? `已签 ${asRow(row).agreeVersion}` : '未签' }}
            </span>
            <span class="stack__sub">
              {{ asRow(row).agreedAt ? formatDateTime(asRow(row).agreedAt) : '—' }}
            </span>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="180" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="goDetail(asRow(row))">详情</el-button>
          <el-tooltip
            :disabled="canManage"
            content="仅管理员 / 超级管理员可变更（改等级即改费率）"
            placement="top"
          >
            <span>
              <el-button link :disabled="!canManage" @click="openUpdate(asRow(row))">
                变更
              </el-button>
            </span>
          </el-tooltip>
          <el-tooltip
            :disabled="canManage"
            content="仅管理员 / 超级管理员可做例外处理（停用/复职/补签）"
            placement="top"
          >
            <span>
              <el-button link :disabled="!canManage" @click="openAudit(asRow(row))">
                例外处理
              </el-button>
            </span>
          </el-tooltip>
        </template>
      </el-table-column>
    </el-table>

    <div class="pager">
      <el-pagination
        v-model:current-page="query.page"
        v-model:page-size="query.pageSize"
        :page-sizes="[10, 20, 50, 100]"
        :total="total"
        layout="total, sizes, prev, pager, next"
        @size-change="reload"
        @current-change="reload"
      />
    </div>

    <!-- ─────────────── D20 任命 / 转交 ─────────────── -->
    <el-dialog v-model="appointVisible" title="任命 / 转交团长" width="620px">
      <div class="dialog__body">
        <el-alert type="info" :closable="false" class="dialog__block">
          <template #title>
            被任命者必须是<b>已注册的小程序用户</b>（团长是叠加身份，没有用户就没有微信身份）。
            目标办公楼若已有在职团长，系统会要求你<b>确认转交</b>，确认后原团长被<b>停职</b>
            （历史佣金与推荐关系保留）。
          </template>
        </el-alert>

        <el-form label-width="110px">
          <el-form-item label="用户 ID" required>
            <el-input-number v-model="appointForm.userId" :min="1" :controls="false" />
            <span class="dialog__tip">ab_user.id（可在「用户」或订单详情里查到）</span>
          </el-form-item>
          <el-form-item label="服务办公楼" required>
            <el-select
              v-model="appointForm.buildingId"
              placeholder="选择办公楼"
              style="width: 100%"
            >
              <el-option
                v-for="b in options.buildings"
                :key="b.id"
                :label="b.name"
                :value="b.id"
                :disabled="b.status !== 1"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="姓名" required>
            <el-input
              v-model="appointForm.realName"
              placeholder="如：国贸三期 · 张磊"
              maxlength="32"
            />
          </el-form-item>
          <el-form-item label="手机号" required>
            <el-input
              v-model="appointForm.phone"
              placeholder="11 位手机号（用于到楼提醒）"
              maxlength="11"
            />
          </el-form-item>
          <el-form-item label="楼层">
            <el-input v-model="appointForm.floor" placeholder="如 12F（选填）" maxlength="32" />
          </el-form-item>
          <el-form-item label="起始等级">
            <el-select v-model="appointForm.level" style="width: 100%">
              <el-option
                v-for="l in options.levels"
                :key="l.key"
                :label="`${l.label}（${l.rateText}）`"
                :value="l.key"
              />
            </el-select>
            <span class="dialog__tip">
              建议保持「见习」，让 C2 双条件（月单 + 介绍转正）自然抬升，避免一上任就给高费率
            </span>
          </el-form-item>
          <el-form-item label="原因" required>
            <el-input
              v-model="appointForm.reason"
              type="textarea"
              :rows="2"
              maxlength="200"
              show-word-limit
              placeholder="任命原因（≥2 字，写入操作日志）"
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="appointVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="doAppoint">确认任命</el-button>
      </template>
    </el-dialog>

    <!-- ─────────────── D21 变更 ─────────────── -->
    <el-dialog v-model="updateVisible" title="变更团长" width="560px">
      <div v-if="current" class="dialog__body">
        <el-alert type="warning" :closable="false" class="dialog__block">
          <template #title>
            改<b>等级会同步改费率</b>（等级只是标签，费率才是钱）。本接口<b>不含停用/复职</b> ——
            那属例外处理，请走 D22，避免两个入口互相打架。
          </template>
        </el-alert>

        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="团长">
            {{ current.realName }}（id={{ current.id }}）
          </el-descriptions-item>
          <el-descriptions-item label="当前等级 / 费率">
            {{ current.levelLabel }} · {{ current.commissionRateText }}
          </el-descriptions-item>
          <el-descriptions-item label="当前办公楼">
            {{ displayOr(current.buildingName) }}
          </el-descriptions-item>
          <el-descriptions-item label="当前楼层">
            {{ displayOr(current.floor) }}
          </el-descriptions-item>
        </el-descriptions>

        <el-form label-width="110px">
          <el-form-item label="目标等级">
            <el-select
              v-model="updateForm.level"
              clearable
              placeholder="不变更"
              style="width: 100%"
            >
              <el-option
                v-for="l in options.levels"
                :key="l.key"
                :label="`${l.label}（${l.rateText}）`"
                :value="l.key"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="目标办公楼">
            <el-select
              v-model="updateForm.buildingId"
              clearable
              placeholder="不变更"
              style="width: 100%"
            >
              <el-option
                v-for="b in options.buildings"
                :key="b.id"
                :label="b.name"
                :value="b.id"
                :disabled="b.status !== 1"
              />
            </el-select>
          </el-form-item>
          <el-form-item label="楼层">
            <el-input
              v-model="updateForm.floor"
              placeholder="不变更；填「-」表示清空"
              maxlength="32"
            />
          </el-form-item>
          <el-form-item label="变更原因" required>
            <el-input
              v-model="updateForm.reason"
              type="textarea"
              :rows="2"
              maxlength="200"
              show-word-limit
              placeholder="≥2 字，写入操作日志"
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="updateVisible = false">取消</el-button>
        <el-button type="primary" :loading="submitting" @click="doUpdate">确认变更</el-button>
      </template>
    </el-dialog>

    <!-- ─────────────── D22 例外处理 ─────────────── -->
    <el-dialog v-model="auditVisible" title="例外处理 / 资质补录" width="560px">
      <div v-if="current" class="dialog__body">
        <el-alert type="info" :closable="false" class="dialog__block">
          <template #title>
            这不是「审核队列」—— 团长是<b>申请即生效</b>的。本操作只做<b>事后留痕与纠偏</b>。
          </template>
        </el-alert>

        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="团长">
            {{ current.realName }}（id={{ current.id }}）
          </el-descriptions-item>
          <el-descriptions-item label="当前状态">
            {{ current.statusLabel }}
          </el-descriptions-item>
        </el-descriptions>

        <el-form label-width="110px">
          <el-form-item label="动作" required>
            <el-select v-model="auditForm.action" style="width: 100%">
              <el-option label="例外停用（违规 / 恶意申请）" value="suspend" />
              <el-option label="恢复在职（纠错，不重置等级）" value="restore" />
              <el-option label="协议补签（历史团长 / 版本升级重签）" value="sign_agreement" />
              <el-option label="资质备注（仅留痕）" value="note" />
            </el-select>
          </el-form-item>
          <el-form-item v-if="auditForm.action === 'sign_agreement'" label="协议版本" required>
            <el-input v-model="auditForm.agreementVersion" placeholder="如 v1.0" maxlength="16" />
          </el-form-item>
          <el-form-item label="原因 / 备注" required>
            <el-input
              v-model="auditForm.reason"
              type="textarea"
              :rows="3"
              maxlength="200"
              show-word-limit
              placeholder="≥2 字。停用请写清违规事实，便于日后申辩复核"
            />
          </el-form-item>
        </el-form>
      </div>
      <template #footer>
        <el-button @click="auditVisible = false">取消</el-button>
        <el-button
          :type="auditForm.action === 'suspend' ? 'danger' : 'primary'"
          :loading="submitting"
          @click="doAudit"
        >
          确认提交
        </el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';

import {
  appointLeader,
  auditLeader,
  fetchAdminLeaders,
  fetchLeaderFilterOptions,
  updateLeader,
  type LeaderAuditActionValue,
  type LeaderFilterOptions,
  type LeaderRow,
  type LeadersSummary,
} from '@/api/leader';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny, formatDateTime } from '@/utils/format';

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const submitting = ref(false);
const rows = ref<LeaderRow[]>([]);
const total = ref(0);
const canManage = ref(false);

const summary = reactive<LeadersSummary>({
  totalCount: 0,
  activeCount: 0,
  suspendedCount: 0,
  traineeCount: 0,
  formalCount: 0,
  goldCount: 0,
  chiefCount: 0,
  monthNewCount: 0,
  monthCommissionFen: 0,
  pendingAuditCount: 0,
});

const options = reactive<LeaderFilterOptions>({
  groups: [],
  buildings: [],
  levels: [],
  statuses: [],
});

const query = reactive({
  groupId: undefined as number | undefined,
  buildingId: undefined as number | undefined,
  level: undefined as string | undefined,
  status: undefined as number | undefined,
  keyword: '',
  page: 1,
  pageSize: 20,
});

const current = ref<LeaderRow | null>(null);

const appointVisible = ref(false);
const appointForm = reactive({
  userId: undefined as number | undefined,
  buildingId: undefined as number | undefined,
  realName: '',
  phone: '',
  floor: '',
  level: 'trainee',
  reason: '',
});

const updateVisible = ref(false);
const updateForm = reactive({
  level: undefined as string | undefined,
  buildingId: undefined as number | undefined,
  floor: undefined as string | undefined,
  reason: '',
});

const auditVisible = ref(false);
const auditForm = reactive({
  action: 'suspend' as LeaderAuditActionValue,
  agreementVersion: 'v1.0',
  reason: '',
});

/** 选了楼群后，办公楼下拉只留该楼群的楼（否则运营会选到跨楼群的楼而莫名报错） */
const buildingChoices = computed(() =>
  query.groupId ? options.buildings.filter((b) => b.groupId === query.groupId) : options.buildings,
);

/** el-table 插槽的 `row` 是宽松的 `DefaultRow`，入口处断言一次，避免 `as` 扩散到模板 */
function asRow(raw: unknown): LeaderRow {
  return raw as LeaderRow;
}

function levelTagType(level: string): 'info' | 'success' | 'warning' | 'danger' {
  if (level === 'chief') return 'danger';
  if (level === 'gold') return 'warning';
  if (level === 'formal') return 'success';
  return 'info';
}

function onGroupChange(): void {
  // 换楼群后，原选中的办公楼可能不在新楼群里 → 清掉，避免「筛选条件自相矛盾返回空列表」
  if (query.buildingId && !buildingChoices.value.some((b) => b.id === query.buildingId)) {
    query.buildingId = undefined;
  }
}

async function reload(): Promise<void> {
  loading.value = true;
  try {
    const res = await fetchAdminLeaders({
      groupId: query.groupId,
      buildingId: query.buildingId,
      level: query.level,
      status: query.status,
      keyword: query.keyword.trim() || undefined,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list ?? [];
    total.value = res.total ?? 0;
    canManage.value = Boolean(res.actions?.canManage);
    Object.assign(summary, res.summary);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '团长名录加载失败');
  } finally {
    loading.value = false;
  }
}

function goDetail(row: LeaderRow): void {
  router.push({ path: '/leader/detail', query: { id: String(row.id) } });
}

function goApplications(): void {
  router.push('/leader/apply');
}

// ------------------------------------------------------------------ D20

function openAppoint(): void {
  Object.assign(appointForm, {
    userId: undefined,
    buildingId: query.buildingId,
    realName: '',
    phone: '',
    floor: '',
    level: 'trainee',
    reason: '',
  });
  appointVisible.value = true;
}

async function doAppoint(): Promise<void> {
  const f = appointForm;
  if (!f.userId || !f.buildingId || !f.realName.trim() || !f.phone.trim()) {
    ElMessage.warning('请填写用户 ID、办公楼、姓名与手机号');
    return;
  }
  if (f.reason.trim().length < 2) {
    ElMessage.warning('请填写任命原因（至少 2 个字）');
    return;
  }

  submitting.value = true;
  try {
    await appointLeader({
      userId: f.userId,
      buildingId: f.buildingId,
      realName: f.realName.trim(),
      phone: f.phone.trim(),
      floor: f.floor.trim() || undefined,
      level: f.level,
      reason: f.reason.trim(),
    });
    appointVisible.value = false;
    ElMessage.success('任命已生效');
    await reload();
  } catch (e) {
    // 20012 转交确认：把「现任是谁」摆到台面上，让人看清了再决定，而不是默默顶替
    if (e instanceof ApiError && e.code === 20012) {
      const occupiedBy = (e.data as { occupiedBy?: { leaderId: number; realName: string } })
        ?.occupiedBy;
      if (occupiedBy) {
        try {
          await ElMessageBox.confirm(
            `该办公楼当前团长为「${occupiedBy.realName}」（id=${occupiedBy.leaderId}）。` +
              '确认转交后，他会被置为停职（历史佣金与推荐关系保留）。',
            '确认转交团长',
            { type: 'warning', confirmButtonText: '确认转交', cancelButtonText: '再想想' },
          );
          submitting.value = true;
          await appointLeader({
            userId: f.userId!,
            buildingId: f.buildingId!,
            realName: f.realName.trim(),
            phone: f.phone.trim(),
            floor: f.floor.trim() || undefined,
            level: f.level,
            transferFromLeaderId: occupiedBy.leaderId,
            reason: f.reason.trim(),
          });
          appointVisible.value = false;
          ElMessage.success(`已完成转交，原团长「${occupiedBy.realName}」已停职`);
          await reload();
        } catch {
          // 用户点了「再想想」→ 什么都不做（保持弹窗，可继续改表单）
        }
      } else {
        ElMessage.error(e.message);
      }
    } else {
      ElMessage.error(e instanceof ApiError ? e.message : '任命失败');
    }
  } finally {
    submitting.value = false;
  }
}

// ------------------------------------------------------------------ D21

function openUpdate(row: LeaderRow): void {
  current.value = row;
  Object.assign(updateForm, {
    level: undefined,
    buildingId: undefined,
    floor: undefined,
    reason: '',
  });
  updateVisible.value = true;
}

async function doUpdate(): Promise<void> {
  if (!current.value) return;
  if (updateForm.reason.trim().length < 2) {
    ElMessage.warning('请填写变更原因（至少 2 个字）');
    return;
  }
  // 「-」是清空楼层的约定（DTO 里 floor 传空字符串会被 forbidNonWhitelisted 之外的
  // minLength 规则影响，故用显式空串表达清空）
  const floor =
    updateForm.floor === undefined
      ? undefined
      : updateForm.floor.trim() === '-'
        ? ''
        : updateForm.floor.trim();

  submitting.value = true;
  try {
    const res = await updateLeader(current.value.id, {
      level: updateForm.level,
      buildingId: updateForm.buildingId,
      floor,
      reason: updateForm.reason.trim(),
    });
    updateVisible.value = false;
    ElMessage.success(res.changes.join('；'));
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '变更失败');
  } finally {
    submitting.value = false;
  }
}

// ------------------------------------------------------------------ D22

function openAudit(row: LeaderRow): void {
  current.value = row;
  Object.assign(auditForm, { action: 'suspend', agreementVersion: 'v1.0', reason: '' });
  auditVisible.value = true;
}

async function doAudit(): Promise<void> {
  if (!current.value) return;
  if (auditForm.reason.trim().length < 2) {
    ElMessage.warning('请填写原因（至少 2 个字）');
    return;
  }
  if (auditForm.action === 'sign_agreement' && !auditForm.agreementVersion.trim()) {
    ElMessage.warning('协议补签须填写协议版本号');
    return;
  }

  submitting.value = true;
  try {
    const res = await auditLeader(current.value.id, {
      action: auditForm.action,
      agreementVersion:
        auditForm.action === 'sign_agreement' ? auditForm.agreementVersion.trim() : undefined,
      reason: auditForm.reason.trim(),
    });
    auditVisible.value = false;
    ElMessage.success(`${res.actionLabel}已完成${res.note ? `（${res.note}）` : ''}`);
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '操作失败');
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  // 从「办公楼管理 → 团长绑定」跳过来时带上 `?buildingId=`，此处预选办公楼筛选 ——
  // 让运营点过来之后不必再自己找一遍楼。参数非法（非数字）则忽略，不影响正常进入本页。
  const pre = Number(route.query.buildingId);
  if (Number.isFinite(pre) && pre > 0) query.buildingId = pre;

  try {
    Object.assign(options, await fetchLeaderFilterOptions());
  } catch {
    // 选择器失败不阻断主列表 —— 名录本身才是这个页面的主任务
  }
  await reload();
});
</script>

<style lang="scss" scoped>
.note {
  margin-bottom: $space-3;
}

.stats {
  display: flex;
  flex-wrap: wrap;
  gap: $space-4;
  padding: $space-2 $space-3;
  margin-bottom: $space-3;
  background: $c-surface;
  border: 1px solid $c-border;
  border-radius: $radius-md;

  &__item {
    display: flex;
    flex-direction: column;
  }

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }

  &__value {
    font-size: $fs-h2;
    font-weight: 700;

    &--ok {
      color: $c-success;
    }

    &--warn {
      color: $c-warning;
    }

    &--muted {
      color: $c-text-weak;
    }

    &--small {
      font-size: $fs-body;
      font-weight: 500;
    }
  }

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
    font-weight: 400;
  }
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-3;

  &__right {
    display: flex;
    gap: $space-2;
    margin-left: auto;
  }
}

.table {
  margin-bottom: $space-3;
}

.stack {
  display: flex;
  flex-direction: column;
  line-height: 1.4;

  &__sub {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.strong {
  font-weight: 700;
}

.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: $fs-caption;
}

.pager {
  display: flex;
  justify-content: flex-end;
}

.dialog {
  &__body {
    display: flex;
    flex-direction: column;
    gap: $space-3;
  }

  &__block {
    margin-bottom: 0;
  }

  &__tip {
    margin-left: $space-2;
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}
</style>
