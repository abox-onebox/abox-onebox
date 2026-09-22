<template>
  <div class="page-container">
    <h2 class="page-container__title">后台账号管理</h2>
    <p class="page-container__meta">
      模块：M37-01 · 接口：D51 列表 / D52 新增 / D53 编辑停用 · 口令以 scrypt
      哈希入库，任何接口都不回显
    </p>

    <!-- 筛选 -->
    <el-form :inline="true" class="filters" @submit.prevent>
      <el-form-item label="关键词">
        <el-input
          v-model="query.keyword"
          placeholder="账号 / 姓名 / 手机号"
          clearable
          style="width: 200px"
          @keyup.enter="reload(1)"
        />
      </el-form-item>
      <el-form-item label="角色">
        <el-select v-model="query.role" placeholder="全部" clearable style="width: 150px">
          <el-option v-for="r in ADMIN_ROLES" :key="r.value" :label="r.label" :value="r.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="状态">
        <el-select v-model="query.status" placeholder="全部" clearable style="width: 120px">
          <el-option label="启用" :value="1" />
          <el-option label="停用" :value="2" />
        </el-select>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" :loading="loading" @click="reload(1)">查询</el-button>
        <el-button @click="resetQuery">重置</el-button>
      </el-form-item>
      <el-form-item>
        <el-button type="primary" plain @click="openCreate">新增账号</el-button>
      </el-form-item>
    </el-form>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column prop="username" label="登录名" min-width="130" />
      <el-table-column prop="name" label="姓名" min-width="110" />
      <el-table-column label="角色" min-width="120">
        <template #default="{ row }">
          <el-tag size="small" :type="row.role === 'supplier' ? 'warning' : 'info'" effect="plain">
            {{ row.roleLabel }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="关联供应商" min-width="130">
        <template #default="{ row }">{{ displayOr(row.supplierName) }}</template>
      </el-table-column>
      <el-table-column label="手机号" min-width="130">
        <template #default="{ row }">{{ maskPhone(row.phone) }}</template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag size="small" :type="row.status === 1 ? 'success' : 'danger'">
            {{ row.statusText }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="最后登录" min-width="160">
        <template #default="{ row }">{{ formatDateTime(row.lastLoginAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button
            link
            :type="row.status === 1 ? 'danger' : 'success'"
            @click="toggleStatus(row)"
          >
            {{ row.status === 1 ? '停用' : '启用' }}
          </el-button>
          <el-tooltip content="该角色可见菜单" placement="top">
            <el-button link type="info" @click="previewMenus(row)">权限</el-button>
          </el-tooltip>
        </template>
      </el-table-column>
      <template #empty>
        <el-empty description="暂无账号" />
      </template>
    </el-table>

    <el-pagination
      class="pager"
      background
      layout="total, prev, pager, next, sizes"
      :total="total"
      :current-page="query.page"
      :page-size="query.pageSize"
      :page-sizes="[10, 20, 50, 100]"
      @current-change="reload"
      @size-change="onSizeChange"
    />

    <!-- 新增 / 编辑 -->
    <el-dialog v-model="dialog.visible" :title="dialog.title" width="520px">
      <el-form ref="formRef" :model="form" :rules="rules" label-width="96px">
        <el-form-item label="登录名" prop="username">
          <el-input
            v-model="form.username"
            :disabled="dialog.mode === 'edit'"
            placeholder="3–64 位字母、数字或 _ . -"
          />
        </el-form-item>
        <el-form-item v-if="dialog.mode === 'create'" label="初始密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="≥8 位，含字母与数字"
          />
        </el-form-item>
        <el-form-item label="姓名" prop="realName">
          <el-input v-model="form.realName" placeholder="选填" />
        </el-form-item>
        <el-form-item label="角色" prop="role">
          <el-select
            v-model="form.role"
            style="width: 100%"
            :disabled="roleLocked"
            @change="onRoleChange"
          >
            <!-- 非超管不列出「超级管理员」：服务端 20010 会拒（见 roleOptions 注释） -->
            <el-option v-for="r in roleOptions" :key="r.value" :label="r.label" :value="r.value" />
          </el-select>
          <span v-if="roleLocked" class="hint">仅超级管理员可变更超级管理员的角色</span>
        </el-form-item>
        <el-form-item v-if="form.role === 'supplier'" label="关联供应商" prop="supplierId">
          <el-input-number
            v-model="form.supplierId"
            :min="1"
            :controls="false"
            style="width: 100%"
          />
          <span class="hint">供应商账号的数据范围锚点（S* / P21–P26），必填</span>
        </el-form-item>
        <el-form-item label="手机号" prop="phone">
          <el-input v-model="form.phone" placeholder="选填" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialog.visible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
/**
 * 系统管理 · 后台账号（D51–D53）
 *
 * ⚠️ 本页是**运营侧**账号管理（`ab_admin_user`），与小程序用户（`ab_user`）无关。
 * ⚠️ 前端弹出「不能停用自己 / 不能动最后一个超管」等提示只是**提前告知**，
 *    判定权威在服务端（20010），前端不复制这套规则 —— 否则两处规则必然漂移。
 * ⚠️ 角色下拉对非超管**不列出「超级管理员」**（`roleOptions`）：同样只是不提供选项，
 *    服务端 D52/D53 会以 20010 拒绝「非超管授予 / 撤销超管」。
 * ⚠️ 供应商角色必须选 supplierId，否则该账号登录后所有 S* 接口都查不到数据，
 *    表现为「空白页」而非报错；服务端已强制（10001）。
 */
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { FormInstance, FormRules } from 'element-plus';

import { ADMIN_ROLES } from '@/api/auth';
import type { AdminAccountRow } from '@/api/system';
import { createAdminAccount, fetchAdminAccounts, updateAdminAccount } from '@/api/system';
import { ApiError } from '@/api/request';
import { displayOr, formatDateTime, maskPhone } from '@/utils/format';
import { useAuthStore } from '@/stores/auth';

const loading = ref(false);
const saving = ref(false);
const rows = ref<AdminAccountRow[]>([]);
const total = ref(0);

const query = reactive({
  keyword: '',
  role: '',
  status: undefined as number | undefined,
  page: 1,
  pageSize: 20,
});

const dialog = reactive({
  visible: false,
  mode: 'create' as 'create' | 'edit',
  title: '新增账号',
  id: 0,
  /** 编辑目标当前的角色（仅用于「非超管不得变更超管角色」的置灰判断） */
  targetRole: '',
});

/**
 * 角色下拉的可选项。
 *
 * ⚠️ 这里**只是不提供选项**（体验层），判定权威在服务端（D52/D53 的 20010）——
 *    与「不能停用自己」同理：前端不复刻规则，否则两处必然漂移。
 *    非超管若绕过界面构造请求把 role 设成 super_admin，服务端照拒。
 */
const auth = useAuthStore();
const isSuperAdmin = computed(() => auth.role === 'super_admin');
const roleOptions = computed(() => {
  const base = isSuperAdmin.value
    ? ADMIN_ROLES
    : ADMIN_ROLES.filter((r) => r.value !== 'super_admin');
  // ⚠️ 必须**总是包含当前值**：非超管编辑一个超管账号时 `form.role === 'super_admin'`，
  //    而 `base` 里刻意没有它（理由见上面那段注释）。`el-select` 找不到匹配的 option 时
  //    会把**原始值当文本显示** ⇒ 屏幕上直接冒出枚举名 `super_admin`（用户看不懂，
  //    且与表格「角色」列用的 `roleLabel` 不一致）。
  //    取值用 `dialog.targetRole`（编辑目标账号的角色）而不是 `form.role`：`form` 在本行
  //    之后才声明，直接引用会踩「块级变量先用后声明」；而 `dialog` 已在上方声明。
  // ⚠️ 这不会开出「非超管授予超管」的口子：该分支只在 `dialog.targetRole === 'super_admin'`
  //    时触发，而那正是 `roleLocked` 为真的情形 —— 下拉同时是 `disabled` 的。
  const cur =
    dialog.mode === 'edit' ? ADMIN_ROLES.find((r) => r.value === dialog.targetRole) : undefined;
  return cur && !base.some((r) => r.value === cur.value) ? [...base, cur] : base;
});
/** 正在编辑一个超管账号、而自己不是超管 → 角色不可改（改了必被服务端拒） */
const roleLocked = computed(
  () => dialog.mode === 'edit' && !isSuperAdmin.value && dialog.targetRole === 'super_admin',
);

const formRef = ref<FormInstance>();
const form = reactive({
  username: '',
  password: '',
  realName: '',
  role: 'operator',
  supplierId: undefined as number | undefined,
  phone: '',
});

const rules: FormRules = {
  username: [{ required: true, message: '请填写登录名', trigger: 'blur' }],
  password: [
    { required: true, message: '请填写初始密码', trigger: 'blur' },
    { min: 8, message: '密码至少 8 位', trigger: 'blur' },
    {
      pattern: /^(?=.*[A-Za-z])(?=.*\d).+$/,
      message: '密码需同时包含字母与数字',
      trigger: 'blur',
    },
  ],
  role: [{ required: true, message: '请选择角色', trigger: 'change' }],
};

async function reload(page?: number): Promise<void> {
  if (page) query.page = page;
  loading.value = true;
  try {
    const res = await fetchAdminAccounts({
      keyword: query.keyword || undefined,
      role: query.role || undefined,
      status: query.status,
      page: query.page,
      pageSize: query.pageSize,
    });
    rows.value = res.list;
    total.value = res.total;
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '账号列表加载失败');
  } finally {
    loading.value = false;
  }
}

function onSizeChange(size: number): void {
  query.pageSize = size;
  void reload(1);
}

function resetQuery(): void {
  query.keyword = '';
  query.role = '';
  query.status = undefined;
  void reload(1);
}

function openCreate(): void {
  dialog.mode = 'create';
  dialog.title = '新增账号';
  dialog.id = 0;
  dialog.targetRole = '';
  Object.assign(form, {
    username: '',
    password: '',
    realName: '',
    role: 'operator',
    supplierId: undefined,
    phone: '',
  });
  dialog.visible = true;
}

/**
 * ⚠️ 这三个函数的入参类型故意写成 `unknown`：
 *    Element Plus 的 `el-table` 插槽把 `row` 推断为 `DefaultRow`
 *    （`Record<string, any>`），与业务类型没有重叠，在模板里直接断言会被
 *    vue-tsc 拒绝。改在函数入口收窄一次，模板保持干净。
 */
function asRow(raw: unknown): AdminAccountRow {
  return raw as AdminAccountRow;
}

function openEdit(raw: unknown): void {
  const row = asRow(raw);
  dialog.mode = 'edit';
  dialog.title = `编辑账号 #${row.id}`;
  dialog.id = row.id;
  dialog.targetRole = row.role;
  Object.assign(form, {
    username: row.username,
    password: '',
    realName: row.name === row.username ? '' : row.name,
    role: row.role,
    supplierId: row.supplierId ?? undefined,
    phone: row.phone ?? '',
  });
  dialog.visible = true;
}

function onRoleChange(value: string): void {
  if (value !== 'supplier') form.supplierId = undefined;
}

async function submit(): Promise<void> {
  const ok = await formRef.value?.validate().catch(() => false);
  if (!ok) return;

  if (form.role === 'supplier' && !form.supplierId) {
    ElMessage.warning('供应商账号必须选择关联供应商');
    return;
  }

  saving.value = true;
  try {
    if (dialog.mode === 'create') {
      await createAdminAccount({
        username: form.username.trim(),
        password: form.password,
        role: form.role,
        realName: form.realName || undefined,
        supplierId: form.role === 'supplier' ? form.supplierId : undefined,
        phone: form.phone || undefined,
      });
      ElMessage.success('账号已创建');
    } else {
      await updateAdminAccount(dialog.id, {
        realName: form.realName,
        role: form.role,
        supplierId: form.role === 'supplier' ? form.supplierId : undefined,
        phone: form.phone,
      });
      ElMessage.success('账号已更新');
    }
    dialog.visible = false;
    await reload();
  } catch (e) {
    ElMessage.error(e instanceof ApiError ? e.message : '保存失败');
  } finally {
    saving.value = false;
  }
}

async function toggleStatus(raw: unknown): Promise<void> {
  const row = asRow(raw);
  const next = row.status === 1 ? 2 : 1;
  const label = next === 2 ? '停用' : '启用';
  try {
    await ElMessageBox.confirm(
      `确认${label}账号「${row.username}」？${next === 2 ? '停用后该账号的令牌将立即失效。' : ''}`,
      `${label}账号`,
      { type: 'warning', confirmButtonText: label, cancelButtonText: '取消' },
    );
  } catch {
    return;
  }

  try {
    await updateAdminAccount(row.id, { status: next });
    ElMessage.success(`已${label}`);
    await reload();
  } catch (e) {
    // 20010 的三条防自锁规则由服务端判定，此处如实透出
    ElMessage.error(e instanceof ApiError ? e.message : `${label}失败`);
  }
}

function previewMenus(raw: unknown): void {
  const row = asRow(raw);
  const menus = row.menus ?? [];
  const text = menus.includes('*') ? '全部菜单（通配）' : menus.join('\n');
  void ElMessageBox.alert(text || '（无菜单）', `「${row.roleLabel}」可见菜单`, {
    confirmButtonText: '知道了',
  });
}

onMounted(() => {
  void reload();
});
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-4;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.filters {
  margin-bottom: $space-2;
}

.pager {
  margin-top: $space-4;
  justify-content: flex-end;
}

.hint {
  margin-left: $space-2;
  font-size: $fs-caption;
  color: $c-text-weak;
}
</style>
