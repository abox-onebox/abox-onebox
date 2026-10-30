<template>
  <el-dialog
    :model-value="modelValue"
    title="修改口令"
    width="440px"
    :close-on-click-modal="false"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <el-alert type="info" :closable="false" class="cpd__note">
      <template #title> 修改成功后会<b>退出当前登录</b>，请用新口令重新登录。 </template>
    </el-alert>

    <el-form :model="form" label-width="88px" @submit.prevent>
      <el-form-item label="原口令">
        <el-input
          v-model="form.oldPassword"
          type="password"
          show-password
          maxlength="128"
          autocomplete="current-password"
          placeholder="当前正在使用的口令"
        />
      </el-form-item>

      <el-form-item label="新口令">
        <el-input
          v-model="form.newPassword"
          type="password"
          show-password
          maxlength="128"
          autocomplete="new-password"
          placeholder="至少 10 位，含字母与数字"
        />
        <div class="cpd__tip">
          至少 10 位且同时含字母与数字；强度规则的真源在服务端，此处只做提前拦。
        </div>
      </el-form-item>

      <el-form-item label="确认新口令">
        <el-input
          v-model="form.confirm"
          type="password"
          show-password
          maxlength="128"
          autocomplete="new-password"
          placeholder="再输一次新口令"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="emit('update:modelValue', false)">取消</el-button>
      <el-button type="primary" :loading="saving" @click="submit">确认修改</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
/**
 * 后台「修改口令」（A6 · 补 admin:coverage 扫出的缺口 #40）
 *
 * ⭐⭐ 为什么挂在**顶栏外壳**而不是「系统 → 账号管理」里：
 *     `ab_admin_user.must_change_password = 1` 的账号，会被 `AdminGuard` 挡住
 *     **所有**业务接口（`admin.guard.ts`）—— 也就是说，被强制改密的人**进不去**任何
 *     业务页面，挂在菜单里的改密入口对他等于不存在。本端点刻意放在 `/auth` 下不经
 *     AdminGuard，就是给这种「被卡死」的状态留的出口；入口跟着端点走，才对得上。
 *
 * ⭐⭐ 为什么成功后必须退出登录：
 *     改密只把库里的 `must_change_password` 清零，**已签发的 JWT 里那个标记还在**。
 *     带着旧令牌继续操作，任何业务接口都会返回 `MUST_CHANGE_PASSWORD`
 *     —— 用户看到的是「改密成功了，但点什么都报错」，比直接重登更难排查。
 *     故此处一律清态回登录页，不留「改完还能点」的半截状态。
 */
import { reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';

import { changeAdminPassword } from '@/api/auth';
import { ApiError } from '@/api/request';

const props = defineProps<{ modelValue: boolean }>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  /** 改密成功 —— 由外壳负责清态并回登录页（本组件不碰路由） */
  (e: 'changed'): void;
}>();

const saving = ref(false);
const form = reactive({ oldPassword: '', newPassword: '', confirm: '' });

/** 每次打开都从空表单开始：口令不该被留在内存里跨次复用 */
watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    form.oldPassword = '';
    form.newPassword = '';
    form.confirm = '';
  },
);

async function submit(): Promise<void> {
  if (!form.oldPassword || !form.newPassword) {
    ElMessage.warning('请填写原口令与新口令');
    return;
  }
  if (form.newPassword.length < 10) {
    ElMessage.warning('新口令至少 10 位');
    return;
  }
  if (form.newPassword !== form.confirm) {
    ElMessage.warning('两次输入的新口令不一致');
    return;
  }
  if (form.newPassword === form.oldPassword) {
    ElMessage.warning('新口令不能与原口令相同');
    return;
  }

  saving.value = true;
  try {
    await changeAdminPassword({
      oldPassword: form.oldPassword,
      newPassword: form.newPassword,
    });
    form.oldPassword = '';
    form.newPassword = '';
    form.confirm = '';
    ElMessage.success('口令已修改，请用新口令重新登录');
    emit('update:modelValue', false);
    emit('changed');
  } catch (e) {
    // 原口令错误 / 强度不足都由服务端给话术，端上不自己编
    ElMessage.error(e instanceof ApiError ? e.message : '修改失败，请稍后重试');
  } finally {
    saving.value = false;
  }
}
</script>

<style lang="scss" scoped>
.cpd__note {
  margin-bottom: $space-3;
}

.cpd__tip {
  color: $c-text-weak;
  font-size: $fs-caption;
  line-height: 1.5;
}
</style>
