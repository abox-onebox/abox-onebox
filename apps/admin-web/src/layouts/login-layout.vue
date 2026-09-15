<template>
  <div class="ab-login">
    <div class="ab-login__card">
      <h1 class="ab-login__title">ABox 一盒 · 管理后台</h1>
      <el-form label-width="72px">
        <el-form-item label="账号">
          <el-input v-model="form.username" placeholder="请输入账号" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input
            v-model="form.password"
            type="password"
            show-password
            placeholder="请输入密码"
          />
        </el-form-item>
        <el-button type="primary" style="width: 100%" @click="onSubmit">登录</el-button>
      </el-form>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();
const form = reactive({ username: '', password: '' });

async function onSubmit() {
  if (!form.username || !form.password) {
    ElMessage.warning('请填写账号与密码');
    return;
  }
  try {
    await auth.login(form.username, form.password);
    router.replace('/dashboard');
  } catch (err) {
    // 账号体系（api/request、api/auth）为 M1 待实现项，此处把真实原因直接暴露出来，
    // 不做"静默成功"——避免骨架阶段看起来能用。
    ElMessage.error(err instanceof Error ? err.message : '登录失败');
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
}
</style>
