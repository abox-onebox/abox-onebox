<template>
  <div class="page-container">
    <h2 class="page-container__title">我的菜品（商家端）</h2>
    <p class="page-container__meta">原型页 / 模块：P23 · M22-01 · 商家端自助</p>

    <el-alert type="warning" :closable="false" show-icon class="note">
      <template #title>
        <b>一期未实装：本页没有可操作的内容。</b>
        供应商登录后确实会看到这个菜单项，但<strong>一期的菜品库由运营在平台端统一维护</strong>，
        商家端不自助增删改菜品。这不是「页面坏了」，而是<strong>尚未排期实现</strong>。
      </template>
    </el-alert>

    <el-card shadow="never" class="card">
      <template #header><span class="card__title">现在要维护菜品，走哪里？</span></template>
      <ol class="steps">
        <li>
          平台端（运营）在「业务 → <strong>菜品库</strong>」维护全部菜品 —— 新增 / 编辑 / 上下架。
        </li>
        <li>
          菜品一旦上架，就会出现在「套餐 → 新建套餐」的选菜列表里， 再经由「套餐模板 → 套餐分配 →
          上架」进入用户端可见的明日菜单。
        </li>
        <li>
          供应商侧目前<strong>已实装</strong>的是
          <strong>出餐确认</strong>（`/supplier/cook-confirm`）与
          <strong>应付结算明细</strong>（`/supplier/settlement`）。
        </li>
      </ol>
    </el-card>

    <el-card shadow="never" class="card">
      <template #header><span class="card__title">这个缺口是怎么登记的</span></template>
      <p class="para">
        本页属 <b>M22 菜品管理</b>（M22-01 我的菜品 · M22-02
        上架申请）的<strong>商家端</strong>部分，
        与平台端「菜品库」（M34）<strong>不是同一件事</strong>：
        前者是「供应商自己提报菜品、平台审核上架」，后者是「运营代维护」。
      </p>
      <p class="para">
        它需要一套<strong>新的后端</strong>（带 `supplierId` 数据隔离的菜品 CRUD +
        上架申请状态机），不是一个页面补丁 —— 故不塞进本次修复批次。 ⚠️
        已登记在《ABox一盒悬而未决登记册》，与 `/supplier/edit`（商家资料）同批。
        <br />
        <strong>在此之前，供应商端的菜品由平台端代维护，功能上不缺东西。</strong>
      </p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 商家端 · 我的菜品（P23 · M22-01）—— **未实装说明页**
 *
 * ⚠️ 本页此前是脚手架占位页（`el-empty` + 「业务实现见目录结构映射表」）。
 *    占位页的问题不是"没做"，而是**不告诉任何信息**：人工测试点到它只能得到
 *    「这里什么都没有」一个结论，无法区分「坏了 / 漏了 / 正常但未排期」。
 *    故改为**如实说明**：一期口径是什么、现在该走哪里、缺口登记在哪。
 *
 * ⚠️ 刻意**不放**指向平台端菜品库的按钮：那是运营端菜单（`ADMIN_MENU_KEYS`），
 *    供应商角色的 `canAccessPath` 会把它挡到 403 —— 放一个点了就 403 的按钮，
 *    比不放更糟。
 */
</script>

<style lang="scss" scoped>
.page-container__meta {
  margin: 0 0 $space-3;
  color: $c-text-weak;
  font-size: $fs-caption;
}

.note {
  margin-bottom: $space-3;

  :deep(.el-alert__title) {
    line-height: 1.7;
  }
}

.card {
  margin-bottom: $space-3;
  border-color: $c-border;

  &__title {
    font-weight: 600;
  }
}

.steps {
  margin: 0;
  padding-left: $space-4;
  color: $c-text;
  font-size: $fs-body;
  line-height: 1.9;
}

.para {
  margin: 0 0 $space-2;
  color: $c-text;
  font-size: $fs-body;
  line-height: 1.8;

  &:last-child {
    margin-bottom: 0;
  }

  code {
    padding: 0 4px;
    border-radius: $radius-sm;
    background: rgba(201, 168, 118, 0.18);
  }
}
</style>
