<template>
  <div class="page-container">
    <h2 class="page-container__title">团长详情 · 档案与裂变链</h2>
    <p class="page-container__meta">
      模块：M33-03/05 · 原型 P32 详情 · 接口：D19 附属详情 ·「详情」按钮从名录/申请流水进入
    </p>

    <div class="toolbar">
      <el-button @click="router.back()">返回</el-button>
      <span v-if="detail" class="toolbar__id">
        团长 id <b>{{ detail.profile.id }}</b> · 用户 id {{ detail.profile.userId }}
      </span>
    </div>

    <el-skeleton v-if="loading" :rows="8" animated />

    <template v-else-if="detail">
      <!-- ─────────────── 档案 ─────────────── -->
      <el-card shadow="never" class="card">
        <template #header>
          <div class="card__header">
            <span class="card__title">{{ detail.profile.realName }}</span>
            <span class="card__tags">
              <!-- 等级徽标（S6）：色块 + 文字标签，替代原「等级四色当文字」方案 -->
              <el-tag size="small" class="ab-level" :class="`ab-level--${detail.profile.level}`">
                {{ detail.profile.levelLabel }} · {{ detail.profile.commissionRateText }}
              </el-tag>
              <el-tag size="small" :type="detail.profile.status === 1 ? 'success' : 'info'">
                {{ detail.profile.statusLabel }}
              </el-tag>
            </span>
          </div>
        </template>

        <el-descriptions :column="3" border size="small">
          <el-descriptions-item label="手机号（脱敏）">
            <span class="mono">{{ displayOr(detail.profile.phoneMasked) }}</span>
          </el-descriptions-item>
          <el-descriptions-item label="微信昵称">
            {{ displayOr(detail.account.nickname) }}
          </el-descriptions-item>
          <el-descriptions-item label="微信标识（后 6 位）">
            <span class="mono">
              {{ detail.account.openidTail ? `…${detail.account.openidTail}` : '—' }}
            </span>
          </el-descriptions-item>

          <el-descriptions-item label="服务办公楼">
            {{ displayOr(detail.profile.buildingName) }}
          </el-descriptions-item>
          <el-descriptions-item label="楼群">
            {{ displayOr(detail.profile.groupName) }}
          </el-descriptions-item>
          <el-descriptions-item label="楼层">{{
            displayOr(detail.profile.floor)
          }}</el-descriptions-item>

          <el-descriptions-item label="月单 / 累计单">
            {{ detail.profile.monthOrders }} / {{ detail.profile.totalOrders }}
          </el-descriptions-item>
          <el-descriptions-item label="介绍转正数">
            {{ detail.profile.invitedFormalCount }} 名
          </el-descriptions-item>
          <el-descriptions-item label="协议">
            {{ displayOr(detail.profile.agreeVersion) }} ·
            {{ detail.profile.agreedAt ? formatDateTime(detail.profile.agreedAt) : '—' }}
          </el-descriptions-item>

          <el-descriptions-item label="可用余额">
            <b>{{ fenToCny(detail.profile.balanceFen) }}</b>
          </el-descriptions-item>
          <el-descriptions-item label="冻结金额">
            {{ fenToCny(detail.profile.frozenFen) }}
          </el-descriptions-item>
          <el-descriptions-item label="累计佣金">
            {{ fenToCny(detail.profile.totalCommissionFen) }}
          </el-descriptions-item>

          <el-descriptions-item label="已提现">
            {{ fenToCny(detail.profile.withdrawnAmountFen) }}
          </el-descriptions-item>
          <el-descriptions-item label="待结算">
            {{ fenToCny(detail.profile.pendingAmountFen) }}
          </el-descriptions-item>
          <el-descriptions-item label="收款方式">
            <el-tag v-if="detail.profile.payoutBound" size="small" type="success">
              {{ detail.profile.payoutType }} · {{ displayOr(detail.profile.payoutAccount) }}
            </el-tag>
            <el-tag v-else size="small" type="warning">未绑定（提现会被 40007 拦下）</el-tag>
          </el-descriptions-item>

          <el-descriptions-item label="最近促单">
            {{ detail.profile.lastOrderAt ? formatDateTime(detail.profile.lastOrderAt) : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="申请时间">
            {{ detail.profile.createdAt ? formatDateTime(detail.profile.createdAt) : '—' }}
          </el-descriptions-item>
          <el-descriptions-item label="邀请渠道">
            {{ channelText(detail.inviteChannel) }}
          </el-descriptions-item>
        </el-descriptions>
      </el-card>

      <!-- ─────────────── 裂变链 ─────────────── -->
      <el-card shadow="never" class="card">
        <template #header>
          <span class="card__title">裂变链（C2 晋级条件的原始依据）</span>
        </template>

        <div class="chain-head">
          <span class="chain-head__label">上行 · 谁推荐了他</span>
          <template v-if="detail.inviter">
            <el-tag size="small" effect="plain">
              {{ detail.inviter.realName }}（{{ detail.inviter.levelLabel }}）
            </el-tag>
            <span class="muted">团长 id {{ detail.inviter.leaderId }}</span>
          </template>
          <span v-else class="muted">—（自荐申请，无推荐人）</span>
        </div>

        <div class="chain-head">
          <span class="chain-head__label">下行 · 他推荐了谁</span>
          <span class="muted">共 {{ detail.invitees.length }} 人</span>
        </div>

        <el-table :data="detail.invitees" size="small" stripe>
          <el-table-column label="被推荐人" min-width="140">
            <template #default="{ row }">
              <div class="stack">
                <span>{{ displayOr(asInvitee(row).realName) }}</span>
                <span class="stack__sub">{{ displayOr(asInvitee(row).nickname) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="团长 id / 用户 id" min-width="150">
            <template #default="{ row }">
              <span class="stack__sub mono">
                {{ asInvitee(row).leaderId ?? '未成为团长' }} / {{ asInvitee(row).inviteeUserId }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="等级" width="90">
            <template #default="{ row }">
              <!-- 等级徽标（S6）：同「团长列表」口径 -->
              <el-tag
                size="small"
                class="ab-level"
                :class="`ab-level--${asInvitee(row).level ?? ''}`"
              >
                {{ asInvitee(row).levelLabel }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="是否转正" width="100">
            <template #default="{ row }">
              <el-tag size="small" :type="asInvitee(row).isFormal ? 'success' : 'info'">
                {{ asInvitee(row).isFormal ? '已转正' : '未转正' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="绑定 / 转正时间" min-width="160">
            <template #default="{ row }">
              <div class="stack">
                <span class="stack__sub">{{ formatDateTime(asInvitee(row).bindAt) }}</span>
                <span class="stack__sub">
                  {{ asInvitee(row).formalAt ? formatDateTime(asInvitee(row).formalAt) : '—' }}
                </span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="80">
            <template #default="{ row }">
              <el-button
                v-if="asInvitee(row).leaderId"
                link
                type="primary"
                @click="goLeader(asInvitee(row).leaderId)"
              >
                查看
              </el-button>
            </template>
          </el-table-column>
        </el-table>

        <el-alert type="info" :closable="false" class="chain-tip">
          <template #title>
            <b>升级口径（C2）</b>：见习→正式须同时满足「月单 &gt; 30 <b>且</b> 介绍 1 名转正团长」；
            金牌、首席依次为 60 / 100 单 + 2 / 3 名转正团长。等级由晋级审计自动抬升，
            后台只在例外情况下手工调整。
          </template>
        </el-alert>
      </el-card>

      <!-- ─────────────── 佣金流水 ─────────────── -->
      <el-card shadow="never" class="card">
        <template #header>
          <span class="card__title">佣金流水（近 20 条 · 含退款冲销负行）</span>
        </template>

        <el-table :data="detail.commissions" size="small" stripe>
          <el-table-column label="订单号" min-width="160">
            <template #default="{ row }">
              <span class="mono">{{ asCommission(row).orderNo }}</span>
            </template>
          </el-table-column>
          <el-table-column label="出餐日" width="110">
            <template #default="{ row }">{{ asCommission(row).mealDate }}</template>
          </el-table-column>
          <el-table-column label="等级 / 费率" width="120">
            <template #default="{ row }">
              <div class="stack">
                <span>{{ asCommission(row).levelLabel }}</span>
                <span class="stack__sub">{{ asCommission(row).rateText }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="计佣基数 / 份数" min-width="140">
            <template #default="{ row }">
              <div class="stack">
                <span>{{ fenToCny(asCommission(row).baseAmountFen) }}</span>
                <span class="stack__sub">{{ asCommission(row).quantity }} 份</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="佣金金额" width="120">
            <template #default="{ row }">
              <span :class="asCommission(row).amountFen < 0 ? 'neg' : 'pos'">
                {{ fenToCny(asCommission(row).amountFen) }}
              </span>
            </template>
          </el-table-column>
          <el-table-column label="类型 / 状态" width="130">
            <template #default="{ row }">
              <div class="stack">
                <el-tag
                  size="small"
                  :type="asCommission(row).type === 'reversal' ? 'danger' : 'info'"
                >
                  {{ asCommission(row).type === 'reversal' ? '退款冲销' : '正常' }}
                </el-tag>
                <span class="stack__sub">{{ statusText(asCommission(row).status) }}</span>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="代扣个税" width="110">
            <template #default="{ row }">{{ fenToCny(asCommission(row).taxWithheldFen) }}</template>
          </el-table-column>
          <el-table-column label="发生时间" min-width="150">
            <template #default="{ row }">
              <span class="stack__sub">{{ formatDateTime(asCommission(row).createdAt) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </el-card>

      <!-- ─────────────── 操作日志 ─────────────── -->
      <el-card shadow="never" class="card">
        <template #header>
          <span class="card__title">操作日志（后台对该团长的全部动作）</span>
        </template>

        <el-table :data="detail.operationLogs" size="small" stripe>
          <el-table-column label="时间" min-width="150">
            <template #default="{ row }">
              <span class="stack__sub">{{ formatDateTime(asLog(row).at) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="动作" min-width="180">
            <template #default="{ row }">{{ asLog(row).action }}</template>
          </el-table-column>
          <el-table-column label="操作人" width="130">
            <template #default="{ row }">{{ displayOr(asLog(row).operator) }}</template>
          </el-table-column>
          <el-table-column label="targetId" width="110">
            <template #default="{ row }">
              <span class="mono">{{ displayOr(asLog(row).targetId) }}</span>
            </template>
          </el-table-column>
        </el-table>

        <el-alert type="info" :closable="false" class="chain-tip">
          <template #title>
            <AbIcon name="warn-tri" size="16" />
            <b>targetId 的两种含义</b>：<b>任命</b>（D20）记录的是<b>被任命用户 id</b>
            （该接口路径与请求体里都没有团长 id）；<b>变更 / 例外处理</b>（D21/D22）记录的是
            <b>团长 id</b>。本页两者都查，所以两个数字都看得见。
          </template>
        </el-alert>
      </el-card>
    </template>

    <el-empty v-else description="未找到该团长" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import { fetchLeaderDetail, type LeaderDetail } from '@/api/leader';
import { ApiError } from '@/api/request';
import { displayOr, fenToCny, formatDateTime } from '@/utils/format';

type Invitee = LeaderDetail['invitees'][number];
type Commission = LeaderDetail['commissions'][number];
type OpLog = LeaderDetail['operationLogs'][number];

const route = useRoute();
const router = useRouter();

const loading = ref(true);
const detail = ref<LeaderDetail | null>(null);

function asInvitee(raw: unknown): Invitee {
  return raw as Invitee;
}
function asCommission(raw: unknown): Commission {
  return raw as Commission;
}
function asLog(raw: unknown): OpLog {
  return raw as OpLog;
}
function channelText(channel: string | null): string {
  if (!channel) return '—';
  if (channel === 'qrcode') return '小程序码';
  if (channel === 'poster') return '海报';
  if (channel === 'link') return '分享链接';
  if (channel === 'self') return '直接申请';
  return channel;
}

function statusText(status: string): string {
  if (status === 'settled') return '已打款';
  if (status === 'pending') return '待结算';
  if (status === 'cancelled') return '已冲销';
  return status;
}

function goLeader(id: number | null): void {
  if (!id) return;
  router.push({ path: '/leader/detail', query: { id: String(id) } });
}

onMounted(async () => {
  const id = Number(route.query.id);
  if (!Number.isFinite(id) || id < 1) {
    loading.value = false;
    ElMessage.warning('缺少团长 id');
    return;
  }
  try {
    detail.value = await fetchLeaderDetail(id);
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '团长详情加载失败');
  } finally {
    loading.value = false;
  }
});
</script>

<style lang="scss" scoped>
.toolbar {
  display: flex;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-3;

  &__id {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.card {
  margin-bottom: $space-3;

  &__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  &__title {
    font-weight: 700;
  }

  &__tags {
    display: flex;
    gap: $space-1;
  }
}

.chain-head {
  display: flex;
  gap: $space-2;
  align-items: center;
  margin-bottom: $space-2;

  &__label {
    color: $c-text-weak;
    font-size: $fs-caption;
  }
}

.chain-tip {
  margin-top: $space-3;
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

.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: $fs-caption;
}

.muted {
  color: $c-text-weak;
}

.pos {
  font-weight: 700;
  color: $c-ok-fg;
}

.neg {
  font-weight: 700;
  color: $c-warn-fg;
}
</style>
