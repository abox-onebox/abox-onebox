<template>
  <div class="ab-login">
    <div class="ab-login__card">
      <h1 class="ab-login__title">ABox 一盒 · 管理后台</h1>
      <el-form label-width="72px" @submit.prevent>
        <el-form-item label="账号">
          <el-input
            v-model="form.username"
            placeholder="请输入账号"
            :disabled="loading"
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="请输入密码"
            :disabled="loading"
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-button type="primary" style="width: 100%" :loading="loading" @click="onSubmit">
          登录
        </el-button>
      </el-form>

      <p class="ab-login__hint">运营账号与供应商账号共用本入口，登录后按角色展示菜单。</p>
    </div>
  </div>
</template>

<script setup lang="ts">
/**
 * 后台登录页（A2）
 *
 * ⚠️ 失败提示**直接使用服务端的 `message`**：后端已把「还可尝试 N 次」与
 *    「已锁定 15 分钟」区分开（错误码同为 20005，见 auth.service.adminLogin），
 *    前端再包一层固定文案会把这两条关键信息抹平。
 *
 * ⚠️ `redirect` 回跳只接受**站内路径**（以 `/` 开头且非 `//`）——
 *    否则 `?redirect=https://evil.com` 会变成开放重定向。
 */
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';

import { ApiError } from '@/api/request';
import { useAuthStore } from '@/stores/auth';
import { usePermissionStore } from '@/stores/permission';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const perm = usePermissionStore();

const form = reactive({ username: '', password: '' });
const loading = ref(false);

/** 只接受站内绝对路径，挡掉协议相对地址（`//evil.com`）与外部 URL */
function safeRedirect(): string {
  const raw = route.query.redirect;
  const target = typeof raw === 'string' ? raw : '';
  if (target.startsWith('/') && !target.startsWith('//')) return target;
  return '';
}

async function onSubmit(): Promise<void> {
  if (!form.username || !form.password) {
    ElMessage.warning('请填写账号与密码');
    return;
  }

  loading.value = true;
  try {
    await auth.login(form.username.trim(), form.password);
    const target = safeRedirect() || perm.landingPath;
    if (!target) {
      ElMessage.warning('该账号未分配到任何菜单，请联系超级管理员');
      void router.replace('/403?reason=no-menu');
      return;
    }
    ElMessage.success('登录成功');
    void router.replace(target);
  } catch (err) {
    ElMessage.error(err instanceof ApiError ? err.message : '登录失败');
  } finally {
    loading.value = false;
  }
}
</script>

<style lang="scss" scoped>
.ab-login {
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: $c-bg;

  &__card {
    width: 380px;
    padding: $space-5;
    background: $c-surface;
    border: 1px solid $c-border;
    border-radius: $radius-lg;
  }

  &__title {
    margin: 0 0 $space-4;
    font-size: $fs-h1;
    color: $c-text;
    text-align: center;
  }

  &__hint {
    margin: $space-3 0 0;
    font-size: $fs-caption;
    line-height: 1.6;
    color: $c-text-weak;
    text-align: center;
  }
}
</style>
