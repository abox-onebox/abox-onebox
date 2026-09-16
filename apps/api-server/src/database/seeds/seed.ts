import 'reflect-metadata';
import 'dotenv/config';

import dataSource from '../data-source';
import { ALL_ENTITIES } from '../entities';
import { Building, BuildingGroup } from '../entities/building.entity';
import { DistributionCenter } from '../entities/finance.entity';
import { LeaderInvite, TeamLeader } from '../entities/leader.entity';
import { MealAssignment, SetMeal, SetMealItem } from '../entities/meal.entity';
import { Dish, Supplier, SupplierDishDaily } from '../entities/supplier.entity';
import { AdminUser, SysConfig } from '../entities/system.entity';
import { User } from '../entities/user.entity';
import { addDays, cutoffAtOf, publishAtOf, todayBj, tomorrowBj } from '../../common/utils/time';

/**
 * 种子数据（依据《种子数据清单 v1.0》）
 *
 * 覆盖：5 楼群 · 12 办公楼 · 5 示例团长 · 4 出餐供应商 + 6 备选 · 4 集散中心 ·
 *       菜品库 · 7 套餐模板 · 全局配置 · 7 日内菜单/分配
 *
 * 纪律：
 *  1. **生产环境禁止导入**（NODE_ENV=production 直接退出）
 *  2. 幂等：基础表先清后插，可反复执行
 *  3. 数字与原型 v4.9.2 同源（李明 186 单 / ¥575.86 等）
 */

const UNIT_PRICE = '25.80'; // C1 锁定：套餐统一售价

/**
 * C9 示例值 · 供应商供价合计（4 家菜品供应商）
 * ⚠️ **非固定口径**：实际以供价表「与各供应商逐菜协商价」为准，
 *    本值仅供本地种子 / 演示使用，禁止在业务逻辑中当作常量校验。
 */
const DEMO_SUPPLIER_COST_TOTAL = '14.00';

function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    console.error('✖ 种子数据禁止在生产环境导入（NODE_ENV=production）');
    process.exit(1);
  }
}

/**
 * 幂等清空：**一次性清空全部 24 张表**，再开始插入。
 *
 * 为什么不能边清边插：
 *   各板块自身的 `repo.clear()` 会按「父 → 子」顺序执行，
 *   例如先清 ab_building_group 时 ab_building 仍持有 FK 引用 → 直接报错。
 *   故统一「关外键 → 逐表 DELETE → 开外键」，与表声明顺序无关，稳定可重复。
 */
async function wipeAll(): Promise<void> {
  const isSqlite = dataSource.options.type === 'better-sqlite3';
  await dataSource.query(isSqlite ? 'PRAGMA foreign_keys = OFF' : 'SET FOREIGN_KEY_CHECKS = 0');
  for (const entity of ALL_ENTITIES) {
    await dataSource.getRepository(entity).clear();
  }
  await dataSource.query(isSqlite ? 'PRAGMA foreign_keys = ON' : 'SET FOREIGN_KEY_CHECKS = 1');
}

async function main(): Promise<void> {
  assertNotProduction();

  await dataSource.initialize();
  console.log('→ 已连接数据库，开始导入种子数据…');

  await wipeAll();
  console.log('→ 已清空全部表（幂等重置完成）');

  // ---------- 1. 楼群（5） ----------
  const bgRepo = dataSource.getRepository(BuildingGroup);
  await bgRepo.clear();
  await bgRepo.save([
    { id: 1, name: '国贸三期组', city: '北京', district: '朝阳区', status: 1, version: 0 },
    { id: 2, name: '建外 SOHO 组', city: '北京', district: '朝阳区', status: 1, version: 0 },
    { id: 3, name: '银泰中心组', city: '北京', district: '朝阳区', status: 1, version: 0 },
    { id: 4, name: '华贸组', city: '北京', district: '朝阳区', status: 1, version: 0 },
    { id: 5, name: '远洋光华组', city: '北京', district: '朝阳区', status: 1, version: 0 },
  ]);

  // ---------- 2. 全局配置（23 项） ----------
  // ⚠️ C9 口径修订（2026-09-15）：成本项**不写死**，全部走配置；平台毛利为**结果值**。
  //    等式：售价 = 供应商供价 + 集散/场地费 + 打包人工 + 配送费 + 佣金 + 平台毛利
  const cfgRepo = dataSource.getRepository(SysConfig);
  await cfgRepo.clear();
  await cfgRepo.save(
    [
      ['set_meal.default_price', UNIT_PRICE, '套餐默认售价（C1 锁定统一定价）'],
      ['set_meal.publish_time', '14:00', '开团时间（T-1）'],
      ['set_meal.cutoff_time', '23:59', '截单时间（语义 = T-1 24:00）'],
      ['order.cutoff_window_minutes', '10', '截单前 10 分钟禁止下单'],
      ['set_meal.delivery_arrival_time', '11:30', '送达办公楼'],
      ['commission.rate.trainee', '0.0800', '见习团长佣金（C2 锁定）'],
      ['commission.rate.formal', '0.0900', '正式团长佣金（C2 锁定）'],
      ['commission.rate.gold', '0.1000', '金牌团长佣金（C2 锁定）'],
      ['commission.rate.chief', '0.1200', '首席团长佣金（C2 锁定）'],
      ['commission.auto_confirm_time', '14:00', '自动确认收货（T 日）'],
      ['commission.settle_hour', '02:00', '佣金结算时点（T+1）'],
      ['commission.min_withdraw', '10.00', '最低提现金额'],
      ['commission.payout_channel', 'FLEX_MANUAL', '出款通道（C11：灵活用工平台人工通道）'],
      ['distribution_center.default_count', '4', '集散中心默认数量（C4 表驱动）'],
      // —— C9 成本项（全部可变，默认 0，按实际登记）——
      [
        'settlement.supplier_purchase_price',
        'negotiated',
        '供应商供价来源：与各供应商**逐菜协商**（非固定）',
      ],
      ['settlement.site_fee', '0.00', '集散/场地费：集散中心**复用合作供应商场地 → 默认 0**'],
      [
        'settlement.packing_labor_fee',
        '0.00',
        '打包人工：雇佣**兼职**打包（按件/按时/按班次），默认 0',
      ],
      ['settlement.delivery_fee', '0.00', '配送费：安排**货拉拉**送货（按趟/按路线），默认 0'],
      [
        'settlement.gross_profit_policy',
        'residual',
        '平台毛利口径：**结果值** = 售价 − 成本合计 − 佣金',
      ],
      [
        'distribution_center.rice_fee',
        '0.00',
        '米饭成本（默认并入供应商供价，本项默认 0，按实际登记）',
      ],
      [
        'distribution_center.pack_fee',
        '0.00',
        '打包费（改由平台兼职打包承担 → packing_labor_fee，本项默认 0）',
      ],
      ['order.max_quantity', '20', '单次下单上限'],
      ['supplier.settle_cycle', 'daily', '供应商结算周期（C11：日结，人工对公转账）'],
      // —— U17 客服入口（2026-09-15 口径：一期不做在线客服，一律引导加客服微信人工处理）——
      // ⚠️ 演示占位值，上线前由运营在后台系统配置页替换为真实客服号
      ['service.wechat_id', 'abox_service', '客服微信号（演示占位；退出团长/资金争议等人工入口）'],
      ['service.wechat_qrcode', '', '客服微信二维码图片 URL（可空，端上按空值隐藏）'],
      ['service.phone', '', '客服电话（可空）'],
      ['service.hours', '工作日 9:00 – 18:00', '客服服务时间'],
      [
        'service.tips',
        '添加客服微信后，请备注「ABox + 你的姓名」，我们会尽快为你处理。',
        '客服页提示文案（端上不自造，服务端下发）',
      ],
    ].map(([configKey, configValue, description]) => ({ configKey, configValue, description })),
  );

  // ---------- 3. 供应商（4 出餐 + 6 备选） ----------
  const supRepo = dataSource.getRepository(Supplier);
  await supRepo.clear();
  await supRepo.save([
    // 出餐型（演示占位名 · C5：不得使用「巡礼之年」）
    {
      id: 1,
      name: '三味屋',
      type: 'both',
      contactName: '王经理',
      contactPhone: '13900000001',
      category: '本帮菜',
      status: 1,
      payeeType: 'corporate',
    },
    {
      id: 2,
      name: '四季鲜蔬',
      type: 'dish',
      contactName: '李经理',
      contactPhone: '13900000002',
      category: '时蔬',
      status: 1,
      payeeType: 'corporate',
    },
    {
      id: 3,
      name: '京味小馆',
      type: 'dish',
      contactName: '赵经理',
      contactPhone: '13900000003',
      category: '京味',
      status: 1,
      payeeType: 'corporate',
    },
    {
      id: 4,
      name: '老李家',
      type: 'dish',
      contactName: '孙经理',
      contactPhone: '13900000004',
      category: '汤品',
      status: 1,
      payeeType: 'corporate',
    },
    // 备选（仅外卖平台跳转，不出餐不分账 · C8：不在用户端溯源页展示）
    {
      id: 5,
      name: '老北京炸酱面',
      type: 'dish',
      contactName: '—',
      contactPhone: '13900000005',
      category: '面食',
      status: 1,
      payeeType: 'corporate',
    },
    {
      id: 6,
      name: '川渝小炒',
      type: 'dish',
      contactName: '—',
      contactPhone: '13900000006',
      category: '川菜',
      status: 1,
      payeeType: 'corporate',
    },
    {
      id: 7,
      name: '粤式烧腊',
      type: 'dish',
      contactName: '—',
      contactPhone: '13900000007',
      category: '烧腊',
      status: 1,
      payeeType: 'corporate',
    },
    {
      id: 8,
      name: '江南私房菜',
      type: 'dish',
      contactName: '—',
      contactPhone: '13900000008',
      category: '江浙菜',
      status: 1,
      payeeType: 'corporate',
    },
    {
      id: 9,
      name: '轻食沙拉工坊',
      type: 'dish',
      contactName: '—',
      contactPhone: '13900000009',
      category: '轻食',
      status: 1,
      payeeType: 'corporate',
    },
    {
      id: 10,
      name: '西北面点',
      type: 'dish',
      contactName: '—',
      contactPhone: '13900000010',
      category: '面点',
      status: 1,
      payeeType: 'corporate',
    },
  ]);

  // ---------- 4. 集散中心（4 · C4 表驱动） ----------
  // ⚠️ C9 修订：集散中心**复用合作供应商场地 → 场地费默认 0**；
  //    打包改由平台雇佣兼职承担（见配置 settlement.packing_labor_fee），故本处费用项默认 0，按实际登记。
  const dcRepo = dataSource.getRepository(DistributionCenter);
  await dcRepo.clear();
  await dcRepo.save([
    {
      id: 1,
      name: '集散中心 1（国贸/建外）',
      supplierId: 1,
      address: '朝阳区建国路 88 号',
      contactName: '王师傅',
      contactPhone: '13800000001',
      riceFee: '0.00',
      packFee: '0.00',
      serviceGroups: [1, 2],
      status: 1,
    },
    {
      id: 2,
      name: '集散中心 2（银泰/建外）',
      supplierId: 2,
      address: '朝阳区光华路 21 号',
      contactName: '刘师傅',
      contactPhone: '13800000002',
      riceFee: '0.00',
      packFee: '0.00',
      serviceGroups: [3, 2],
      status: 1,
    },
    {
      id: 3,
      name: '集散中心 3（国贸/远洋）',
      supplierId: 3,
      address: '朝阳区东三环中路 65 号',
      contactName: '赵师傅',
      contactPhone: '13800000003',
      riceFee: '0.00',
      packFee: '0.00',
      serviceGroups: [1, 5],
      status: 1,
    },
    {
      id: 4,
      name: '集散中心 4（华贸组）',
      supplierId: 4,
      address: '朝阳区四惠东',
      contactName: '钱师傅',
      contactPhone: '13800000004',
      riceFee: '0.00',
      packFee: '0.00',
      serviceGroups: [4],
      status: 1,
    },
  ]);

  // ---------- 5. 菜品库 ----------
  // 说明：清单 §五 明确 8 道；另补 4 道主菜以支撑 §六 的 7 个套餐模板
  // ⚠️ C9 修订：`costPrice` 为**菜品供价示例值**，实际以「与各供应商逐菜协商价」为准（非固定口径）
  const dishRepo = dataSource.getRepository(Dish);
  await dishRepo.clear();
  await dishRepo.save([
    {
      id: 1,
      supplierId: 1,
      name: '红烧肉',
      category: 'main',
      costPrice: '7.50',
      rating: '4.90',
      status: 1,
    },
    {
      id: 2,
      supplierId: 1,
      name: '东坡肉',
      category: 'main',
      costPrice: '8.50',
      rating: '4.80',
      status: 1,
    },
    {
      id: 3,
      supplierId: 1,
      name: '啤酒鸭',
      category: 'main',
      costPrice: '8.00',
      rating: '4.70',
      status: 1,
    },
    {
      id: 4,
      supplierId: 2,
      name: '清炒时蔬',
      category: 'veg',
      costPrice: '3.00',
      rating: '4.60',
      status: 1,
    },
    {
      id: 5,
      supplierId: 2,
      name: '凉拌黄瓜',
      category: 'veg',
      costPrice: '2.20',
      rating: '4.50',
      status: 1,
    },
    {
      id: 6,
      supplierId: 3,
      name: '卤蛋',
      category: 'half',
      costPrice: '1.50',
      rating: '4.60',
      status: 1,
    },
    {
      id: 7,
      supplierId: 4,
      name: '酸辣汤',
      category: 'soup',
      costPrice: '2.00',
      rating: '4.70',
      status: 1,
    },
    {
      id: 8,
      supplierId: 4,
      name: '番茄蛋汤',
      category: 'soup',
      costPrice: '2.00',
      rating: '4.50',
      status: 1,
    },
    // 套餐模板扩展主菜（同归三味屋）
    {
      id: 9,
      supplierId: 1,
      name: '宫保鸡丁',
      category: 'main',
      costPrice: '6.50',
      rating: '4.60',
      status: 1,
    },
    {
      id: 10,
      supplierId: 1,
      name: '清真牛肉',
      category: 'main',
      costPrice: '8.50',
      rating: '4.70',
      status: 1,
    },
    {
      id: 11,
      supplierId: 1,
      name: '番茄鱼',
      category: 'main',
      costPrice: '8.00',
      rating: '4.60',
      status: 1,
    },
    {
      id: 12,
      supplierId: 1,
      name: '咖喱鸡',
      category: 'main',
      costPrice: '6.00',
      rating: '4.50',
      status: 1,
    },
  ]);

  // ---------- 6. 办公楼（12 栋） ----------
  // ⚠️ 状态三态（M3-7）：1 营业中 / 2 待开通 / 3 已暂停 —— 见 BuildingStatus。
  //    M3-7 之前「待开通」与「已暂停」都写成 2，一值两义；本批次拆开。
  // ⚠️ population 是**运营估算的覆盖人数**（原型 P37 列表「约 N 人」），非实时统计。
  const bRepo = dataSource.getRepository(Building);
  await bRepo.clear();
  await bRepo.save([
    {
      id: 1,
      buildingGroupId: 1,
      name: '国贸三期 A 座',
      address: '建国门外大街 1 号 A 座',
      city: '北京',
      district: '朝阳区',
      population: 520,
      status: 1,
    },
    {
      id: 2,
      buildingGroupId: 1,
      name: '国贸三期 B 座',
      address: '建国门外大街 1 号 B 座',
      city: '北京',
      district: '朝阳区',
      population: 480,
      status: 1,
    },
    {
      id: 3,
      buildingGroupId: 1,
      name: '国贸三期 C 座',
      address: '建国门外大街 1 号 C 座',
      city: '北京',
      district: '朝阳区',
      population: 310,
      status: 2,
    },
    {
      id: 4,
      buildingGroupId: 1,
      name: '国贸三期 D 座',
      address: '建国门外大街 1 号 D 座',
      city: '北京',
      district: '朝阳区',
      population: 250,
      status: 1,
    },
    {
      id: 5,
      buildingGroupId: 2,
      name: '建外 SOHO 北区',
      address: '东三环中路 39 号',
      city: '北京',
      district: '朝阳区',
      population: 480,
      status: 1,
    },
    {
      id: 6,
      buildingGroupId: 3,
      name: '银泰中心 1 栋',
      address: '建国门外大街 2 号 1 栋',
      city: '北京',
      district: '朝阳区',
      population: 360,
      status: 1,
    },
    {
      id: 7,
      buildingGroupId: 3,
      name: '银泰中心 2 栋',
      address: '建国门外大街 2 号 2 栋',
      city: '北京',
      district: '朝阳区',
      population: 320,
      status: 1,
    },
    {
      id: 8,
      buildingGroupId: 4,
      name: '华贸 1 号楼',
      address: '建国路 79 号 1 号楼',
      city: '北京',
      district: '朝阳区',
      population: 380,
      status: 1,
    },
    {
      id: 9,
      buildingGroupId: 4,
      name: '华贸 2 号楼',
      address: '建国路 79 号 2 号楼',
      city: '北京',
      district: '朝阳区',
      population: 280,
      status: 1,
    },
    {
      id: 10,
      buildingGroupId: 4,
      name: '华贸 3 号楼',
      address: '建国路 79 号 3 号楼',
      city: '北京',
      district: '朝阳区',
      population: 260,
      status: 3,
    },
    {
      id: 11,
      buildingGroupId: 5,
      name: '远洋光华 AB 座',
      address: '光华路 9 号 AB 座',
      city: '北京',
      district: '朝阳区',
      population: 320,
      status: 1,
    },
    {
      id: 12,
      buildingGroupId: 5,
      name: '远洋光华 C 座',
      address: '光华路 9 号 C 座',
      city: '北京',
      district: '朝阳区',
      population: 200,
      status: 1,
    },
  ]);

  // ---------- 7. 用户（5 示例用户，与团长一一对应） ----------
  const userRepo = dataSource.getRepository(User);
  await userRepo.save([
    {
      id: 1001,
      openid: 'mock_openid_1001',
      nickname: '李明',
      phone: '18600000001',
      buildingId: 1,
      teamLeaderId: null,
      status: 1,
    },
    {
      id: 1002,
      openid: 'mock_openid_1002',
      nickname: '王芳',
      phone: '18600000002',
      buildingId: 4,
      teamLeaderId: 1,
      status: 1,
    },
    {
      id: 1003,
      openid: 'mock_openid_1003',
      nickname: '张磊',
      phone: '18600000003',
      buildingId: 5,
      teamLeaderId: 1,
      status: 1,
    },
    {
      id: 1004,
      openid: 'mock_openid_1004',
      nickname: '赵静',
      phone: '18600000004',
      buildingId: 6,
      teamLeaderId: 1,
      status: 1,
    },
    {
      id: 1005,
      openid: 'mock_openid_1005',
      nickname: '陈强',
      phone: '18600000005',
      buildingId: 2,
      teamLeaderId: null,
      status: 1,
    },
  ]);

  // ---------- 8. 团长（5 · 等级/费率/佣金与原型一致） ----------
  // 校验式：月单 × 25.80 × 费率 —— 李明 186×25.80×12% = 575.86 / 王芳 78×10% = 201.24
  // 张磊 42×9% = 97.52 / 赵静 30×9% = 69.66 / 陈强 8×8% = 16.51
  const tlRepo = dataSource.getRepository(TeamLeader);
  await tlRepo.save([
    {
      id: 1,
      userId: 1001,
      buildingId: 1,
      phone: '18600000001',
      realName: '李明',
      floor: '12F',
      level: 'chief',
      commissionRate: '0.1200',
      status: 1,
      monthOrders: 186,
      totalOrders: 186,
      invitedFormalCount: 5,
      totalCommission: '575.86',
      balance: '575.86',
      agreedAt: new Date('2026-06-01T10:00:00Z'),
    },
    {
      id: 2,
      userId: 1002,
      buildingId: 4,
      phone: '18600000002',
      realName: '王芳',
      floor: '8F',
      level: 'gold',
      commissionRate: '0.1000',
      status: 1,
      monthOrders: 78,
      totalOrders: 78,
      invitedFormalCount: 3,
      totalCommission: '201.24',
      balance: '201.24',
      agreedAt: new Date('2026-06-15T10:00:00Z'),
    },
    {
      id: 3,
      userId: 1003,
      buildingId: 5,
      phone: '18600000003',
      realName: '张磊',
      floor: '6F',
      level: 'formal',
      commissionRate: '0.0900',
      status: 1,
      monthOrders: 42,
      totalOrders: 42,
      invitedFormalCount: 1,
      totalCommission: '97.52',
      balance: '97.52',
      agreedAt: new Date('2026-07-01T10:00:00Z'),
    },
    {
      id: 4,
      userId: 1004,
      buildingId: 6,
      phone: '18600000004',
      realName: '赵静',
      floor: '15F',
      level: 'formal',
      commissionRate: '0.0900',
      status: 1,
      monthOrders: 30,
      totalOrders: 30,
      invitedFormalCount: 0,
      totalCommission: '69.66',
      balance: '69.66',
      agreedAt: new Date('2026-07-10T10:00:00Z'),
    },
    {
      id: 5,
      userId: 1005,
      buildingId: 2,
      phone: '18600000005',
      realName: '陈强',
      floor: '3F',
      level: 'trainee',
      commissionRate: '0.0800',
      status: 1,
      monthOrders: 8,
      totalOrders: 8,
      invitedFormalCount: 0,
      totalCommission: '16.51',
      balance: '16.51',
      agreedAt: new Date('2026-09-01T10:00:00Z'),
    },
  ]);

  // ---------- 9. 推荐关系（C2 晋级审计） ----------
  const invRepo = dataSource.getRepository(LeaderInvite);
  await invRepo.save([
    {
      id: 1,
      inviterLeaderId: 1,
      inviteeUserId: 1002,
      inviteeLeaderId: 2,
      channel: 'qrcode',
      bindAt: new Date('2026-06-15T09:00:00Z'),
      isFormal: 1,
      formalAt: new Date('2026-08-01T09:00:00Z'),
    },
    {
      id: 2,
      inviterLeaderId: 1,
      inviteeUserId: 1003,
      inviteeLeaderId: 3,
      channel: 'link',
      bindAt: new Date('2026-07-01T09:00:00Z'),
      isFormal: 1,
      formalAt: new Date('2026-08-20T09:00:00Z'),
    },
    {
      id: 3,
      inviterLeaderId: 1,
      inviteeUserId: 1004,
      inviteeLeaderId: 4,
      channel: 'poster',
      bindAt: new Date('2026-07-10T09:00:00Z'),
      isFormal: 1,
      formalAt: new Date('2026-09-01T09:00:00Z'),
    },
    {
      id: 4,
      inviterLeaderId: null,
      inviteeUserId: 1005,
      inviteeLeaderId: 5,
      channel: 'self',
      bindAt: new Date('2026-09-01T09:00:00Z'),
      isFormal: 0,
    },
  ]);

  // ---------- 10. 套餐模板（7）+ 明细 ----------
  const smRepo = dataSource.getRepository(SetMeal);
  const smiRepo = dataSource.getRepository(SetMealItem);
  await smRepo.save([
    {
      id: 1,
      name: '红烧肉套餐',
      price: '25.80',
      costPrice: DEMO_SUPPLIER_COST_TOTAL, // 示例值：实际按与各供应商逐菜协商价
      oneLiner: '招牌红烧肉 · 一饭四菜',
      status: 1,
    },
    {
      id: 2,
      name: '东坡肉套餐',
      price: '29.80',
      costPrice: '15.00',
      oneLiner: '慢炖东坡肉 · 一饭四菜',
      status: 1,
    },
    {
      id: 3,
      name: '宫保鸡丁套餐',
      price: '25.80',
      costPrice: '13.50',
      oneLiner: '川味宫保鸡丁 · 一饭四菜',
      status: 1,
    },
    {
      id: 4,
      name: '清真牛肉套餐',
      price: '28.80',
      costPrice: '15.50',
      oneLiner: '清真牛肉 · 一饭四菜',
      status: 1,
    },
    {
      id: 5,
      name: '番茄鱼套餐',
      price: '28.80',
      costPrice: '15.00',
      oneLiner: '番茄鱼片 · 一饭四菜',
      status: 1,
    },
    {
      id: 6,
      name: '啤酒鸭套餐',
      price: '27.80',
      costPrice: '14.50',
      oneLiner: '啤酒鸭 · 一饭四菜',
      status: 1,
    },
    {
      id: 7,
      name: '咖喱鸡套餐',
      price: '25.80',
      costPrice: '13.00',
      oneLiner: '台式咖喱鸡 · 一饭四菜',
      status: 1,
    },
  ]);
  // slot：1 主荤 / 2 半荤 / 3 素菜 / 4 汤 / 5 主食
  // 主食由集散中心统一供米（¥2/份），不计入供应商菜品成本，故不建 item
  await smiRepo.save([
    { setMealId: 1, dishId: 1, supplierId: 1, slot: 1, shareAmount: '7.50' },
    { setMealId: 1, dishId: 6, supplierId: 3, slot: 2, shareAmount: '1.50' },
    { setMealId: 1, dishId: 4, supplierId: 2, slot: 3, shareAmount: '3.00' },
    { setMealId: 1, dishId: 7, supplierId: 4, slot: 4, shareAmount: '2.00' },
    { setMealId: 2, dishId: 2, supplierId: 1, slot: 1, shareAmount: '8.50' },
    { setMealId: 2, dishId: 6, supplierId: 3, slot: 2, shareAmount: '1.50' },
    { setMealId: 2, dishId: 4, supplierId: 2, slot: 3, shareAmount: '3.00' },
    { setMealId: 2, dishId: 7, supplierId: 4, slot: 4, shareAmount: '2.00' },
    { setMealId: 3, dishId: 9, supplierId: 1, slot: 1, shareAmount: '6.50' },
    { setMealId: 3, dishId: 6, supplierId: 3, slot: 2, shareAmount: '1.50' },
    { setMealId: 3, dishId: 4, supplierId: 2, slot: 3, shareAmount: '3.00' },
    { setMealId: 3, dishId: 8, supplierId: 4, slot: 4, shareAmount: '2.00' },
    { setMealId: 4, dishId: 10, supplierId: 1, slot: 1, shareAmount: '8.50' },
    { setMealId: 4, dishId: 4, supplierId: 2, slot: 3, shareAmount: '3.00' },
    { setMealId: 4, dishId: 8, supplierId: 4, slot: 4, shareAmount: '2.00' },
    { setMealId: 5, dishId: 11, supplierId: 1, slot: 1, shareAmount: '8.00' },
    { setMealId: 5, dishId: 6, supplierId: 3, slot: 2, shareAmount: '1.50' },
    { setMealId: 5, dishId: 4, supplierId: 2, slot: 3, shareAmount: '3.00' },
    { setMealId: 5, dishId: 7, supplierId: 4, slot: 4, shareAmount: '2.00' },
    { setMealId: 6, dishId: 3, supplierId: 1, slot: 1, shareAmount: '8.00' },
    { setMealId: 6, dishId: 6, supplierId: 3, slot: 2, shareAmount: '1.50' },
    { setMealId: 6, dishId: 4, supplierId: 2, slot: 3, shareAmount: '3.00' },
    { setMealId: 6, dishId: 7, supplierId: 4, slot: 4, shareAmount: '2.00' },
    { setMealId: 7, dishId: 12, supplierId: 1, slot: 1, shareAmount: '6.00' },
    { setMealId: 7, dishId: 6, supplierId: 3, slot: 2, shareAmount: '1.50' },
    { setMealId: 7, dishId: 4, supplierId: 2, slot: 3, shareAmount: '3.00' },
    { setMealId: 7, dishId: 8, supplierId: 4, slot: 4, shareAmount: '2.00' },
  ]);

  // ---------- 11. 分配与每日菜单（**日期相对**：随运行日自动前移，禁止写死） ----------
  // ⚠️ 历史缺陷：旧实现把 mealDate 写死为某个具体日期，导致「次日套餐」在第二天即失效
  //    （U1 取明日套餐 → 查无分配 → 30005「该办公楼今日未开团」）。
  //    现改为按运行日推算：T+1 = 明日（可下单）· T-1 = 昨日（供 U2 历史归档）。
  const TODAY = todayBj();
  const TOMORROW = tomorrowBj();
  const YESTERDAY = addDays(TODAY, -1);

  const maRepo = dataSource.getRepository(MealAssignment);
  await maRepo.save([
    {
      mealDate: TOMORROW,
      buildingGroupId: 1,
      setMealId: 1,
      distributionCenterId: 1,
      status: 'active',
      publishAt: publishAtOf(TOMORROW),
      cutoffAt: cutoffAtOf(TOMORROW),
      soldCount: 45,
    },
    {
      mealDate: TOMORROW,
      buildingGroupId: 2,
      setMealId: 1,
      distributionCenterId: 1,
      status: 'active',
      soldCount: 0,
    },
    {
      mealDate: TOMORROW,
      buildingGroupId: 3,
      setMealId: 2,
      distributionCenterId: 2,
      status: 'active',
      soldCount: 0,
    },
    {
      mealDate: TOMORROW,
      buildingGroupId: 4,
      setMealId: 3,
      distributionCenterId: 4,
      status: 'pending',
      soldCount: 0,
    },
    {
      mealDate: TOMORROW,
      buildingGroupId: 5,
      setMealId: 4,
      distributionCenterId: 3,
      status: 'pending',
      soldCount: 0,
    },
    // —— 历史归档（T-1）：供 U2 `/home/history` 有数据可查 ——
    {
      mealDate: YESTERDAY,
      buildingGroupId: 1,
      setMealId: 2,
      distributionCenterId: 1,
      status: 'active',
      publishAt: publishAtOf(YESTERDAY),
      cutoffAt: cutoffAtOf(YESTERDAY),
      soldCount: 52,
    },
  ]);

  const sddRepo = dataSource.getRepository(SupplierDishDaily);
  await sddRepo.save([
    {
      supplierId: 1,
      dishId: 1,
      produceDate: TOMORROW,
      planQuantity: 45,
      unitPrice: '7.50',
      status: 'pending',
    },
    {
      supplierId: 2,
      dishId: 4,
      produceDate: TOMORROW,
      planQuantity: 45,
      unitPrice: '3.00',
      status: 'pending',
    },
    {
      supplierId: 3,
      dishId: 6,
      produceDate: TOMORROW,
      planQuantity: 45,
      unitPrice: '1.50',
      status: 'pending',
    },
    {
      supplierId: 4,
      dishId: 7,
      produceDate: TOMORROW,
      planQuantity: 45,
      unitPrice: '2.00',
      status: 'pending',
    },
  ]);

  // ---------- 12. 后台账号 ----------
  const adminRepo = dataSource.getRepository(AdminUser);
  await adminRepo.save([
    // 密码明文 admin123（开发期占位；上线前改为 bcrypt 种子）
    {
      id: 1,
      username: 'admin',
      passwordHash: 'dev_plain:admin123',
      realName: '超级管理员',
      role: 'super_admin',
      status: 1,
    },
    {
      id: 2,
      username: 'finance',
      passwordHash: 'dev_plain:finance123',
      realName: '财务',
      role: 'finance',
      status: 1,
    },
    {
      id: 3,
      username: 'sanweiwu',
      passwordHash: 'dev_plain:supplier123',
      realName: '三味屋',
      role: 'supplier',
      supplierId: 1,
      status: 1,
    },
  ]);

  // ---------- 校验 ----------
  const check = {
    楼群: await bgRepo.count(),
    办公楼: await bRepo.count(),
    团长: await tlRepo.count(),
    推荐关系: await invRepo.count(),
    供应商: await supRepo.count(),
    集散中心: await dcRepo.count(),
    菜品: await dishRepo.count(),
    套餐: await smRepo.count(),
    套餐明细: await smiRepo.count(),
    配置: await cfgRepo.count(),
  };

  console.log('✔ 种子导入完成：', JSON.stringify(check, null, 0));
  console.log(
    `  出餐日锚点（随运行日推算）：昨日 ${YESTERDAY}（历史归档）· 今日 ${TODAY} · 明日 ${TOMORROW}（可下单）`,
  );

  // C9 口径修订（2026-09-15）：成本项**可配置**、平台毛利为**结果值**
  // 下面用「示例值」演示等式闭合，实际一律以配置项 / 协商价 / 实际发生额为准
  const demoSupplier = Number(DEMO_SUPPLIER_COST_TOTAL); // 供应商供价（示例）
  const demoSiteFee = 0; // 集散/场地费（复用合作供应商场地 → 默认 0）
  const demoPackingLabor = 0; // 打包人工（兼职）
  const demoDelivery = 0; // 配送费（货拉拉）
  const demoRate = 0.12; // 首席团长
  const demoCommission = Number((Number(UNIT_PRICE) * demoRate).toFixed(2));
  const demoGross =
    Number(UNIT_PRICE) -
    (demoSupplier + demoSiteFee + demoPackingLabor + demoDelivery) -
    demoCommission;

  console.log('  单份结算等式（成本项可配置 · 平台毛利为结果值）：');
  console.log(
    `    售价 ${UNIT_PRICE} = 供价 ${demoSupplier.toFixed(2)}(示例) + 场地 ${demoSiteFee.toFixed(2)} + 打包人工 ${demoPackingLabor.toFixed(2)} + 配送 ${demoDelivery.toFixed(2)} + 佣金 ${demoCommission.toFixed(2)}(首席 12%) + 毛利 ${demoGross.toFixed(2)}(结果值)`,
  );
  console.log(
    '    ⚠️ 供应商供价按逐菜协商、打包人工与配送费按实际发生登记 —— 以上为示例，非固定口径',
  );
  console.log('  测试登录：POST /api/v1/auth/login  { "code": "dev:1001" }  → 李明（首席团长）');

  await dataSource.destroy();
}

main().catch((err) => {
  console.error('✖ 种子导入失败：', err);
  process.exit(1);
});
