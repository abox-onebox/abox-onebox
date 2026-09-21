<template>
  <div class="page-container">
    <h2 class="page-container__title">上架申请 / 商家资料（商家端）</h2>
    <p class="page-container__meta">原型页 / 模块：P24 / P26 · M22-02 · M24 · 商家端自助</p>

    <el-alert type="warning" :closable="false" show-icon class="note">
      <template #title>
        <b>一期未实装：本页没有可操作的内容。</b>
        供应商的<strong>资质与资料</strong>目前由运营在平台端录入（「供应商与出餐 → 供应商管理 →
        新建 / 编辑 / 资质补录」），商家端不自助维护。
      </template>
    </el-alert>

    <el-card shadow="never" class="card">
      <template #header><span class="card__title">现在要改资料 / 报菜品，走哪里？</span></template>
      <ol class="steps">
        <li>
          <strong>供应商资料</strong>（名称 / 联系人 / 结算账户 / 资质证照）： 运营在「供应商与出餐
          → 供应商管理」里维护，含 `新建` 与 `资质补录` ——
          这也是<strong>资质合规的留痕点</strong>（谁在什么时候补了什么证）。
        </li>
        <li>
          <strong>菜品上架</strong>：一期的菜品由运营在「供应商与出餐 → 菜品库」代维护，
          见同组菜单「我的菜品」页的说明。
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
        本页对应 <b>M22-02 上架申请</b> 与 <b>M24 商家资料</b>的<strong>商家端</strong>部分。
        两者都需要「提交 → 平台审核」的状态机（否则供应商可以自己把菜品挂上架、 自己改结算账户 ——
        前者影响成本口径，后者是资金风险）。
      </p>
      <p class="para">
        ⚠️ 已登记在《ABox一盒悬而未决登记册》，与「我的菜品」同批。
        <strong>一期由平台代维护，功能上不缺东西。</strong>
      </p>
    </el-card>
  </div>
</template>

<script setup lang="ts">
/**
 * 商家端 · 上架申请 / 商家资料（P24 / P26 · M22-02 · M24）—— **未实装说明页**
 *
 * ⚠️ 与「我的菜品」同一处理：把无信息的占位页换成**如实说明**
 *    （一期口径 / 现在走哪里 / 缺口登记在哪）。
 *
 * ⚠️ 本页同时是「**供应商侧不能自助**」这条口径的说明位：
 *    结算账户与资质若开给商家自助改，等于把资金与合规的写点交给被监管方；
 *    故一期刻意只在平台端开放（`admin/suppliers` 的 `settle-account` /
 *    `audit` 两个接口，且 `@Roles('super_admin','admin')`）。
 *
 * ⚠️ **指路文案是本页唯一的产出，故必须指向「现值」**（外部测试报告 PR-09 · 2026-09-21 收口）：
 *    ① 分组名一律取 `apps/admin-web/src/constants/index.ts` 的 `ADMIN_NAV`
 *      —— M5-16 已由 6 组重整为 **8 组，其中没有名为「业务」的组**，
 *      供应商相关两页现挂在「**供应商与出餐**」组（`/supplier/list` 供应商管理 · `/supplier/dish-library` 菜品库）；
 *    ② 已剔除**不再由运营维护**的字段：`ab_supplier.type`（M4-0 起 D27 整条路由下线、
 *      `form.vue` 的 `typeOptions`/`typeLocked` 一并删除，该列仅作历史字段保留）。
 *    指到一个不存在的分组 = 把「缺口已登记」变成「**按提示也走不通**」——
 *    正好落回本页想消灭的那种体验。
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
