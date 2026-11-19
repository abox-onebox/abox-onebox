import {
  CHANNEL_REQUIREMENT,
  MESSAGE_TEMPLATE_SPECS,
  WX_BIZ_FIELD_LABEL,
  findUnknownVariables,
  missingForEnable,
  specState,
  subscribeTemplateOf,
} from '../../src/modules/admin/template/message-template.specs';

/**
 * 通知场景声明 · 结构自检（D60++）
 *
 * ⚠️ 本文件钉的是**平台规则与跨字段一致性**，不是业务文案：
 *   · 微信公共模板库**最少 2 个、最多 5 个**关键词（运营在后台勾选时的硬约束）；
 *   · `wiring='live'` 却没有任何 `wxFields` ⇒ 投递时必然「模板关键词未映射」，
 *     而这个错**只在真实发送那一刻**才暴露（Mock 通道下永远"成功"）；
 *   · 后台页面展示的是 `WX_BIZ_FIELD_LABEL` 的中文名，缺一项运营就只能看到代码名，
 *     进而选错模板 → `47003`。
 *
 * 这几条都属于「不写测试就一定会在某次改动里悄悄破掉」的那一类：
 * 它们跨了两个文件（specs / 后台）与一个外部平台（微信）的约束。
 */
describe('通知场景声明 · 结构自检（D60++）', () => {
  it('场景键唯一（库里 scene 是主键般的存在，重复会让 toView 二义）', () => {
    const keys = MESSAGE_TEMPLATE_SPECS.map((s) => s.scene);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每个「走订阅消息 + 已接线」的场景都必须声明 wxFields', () => {
    const bad = MESSAGE_TEMPLATE_SPECS.filter(
      (s) => s.channels.includes('wechat_subscribe') && s.wiring === 'live' && !s.wxFields,
    ).map((s) => s.scene);
    // 空数组 = 全部合规。若这里红了，说明场景会「显示已启用、投递时报未映射」
    expect(bad).toEqual([]);
  });

  it('每个 wxFields 的关键词数量都在微信允许的 2–5 个之间（防止单字段回归）', () => {
    const bad = MESSAGE_TEMPLATE_SPECS.filter((s) => {
      const n = Object.keys(s.wxFields ?? {}).length;
      return s.channels.includes('wechat_subscribe') && s.wiring === 'live' && (n < 2 || n > 5);
    }).map((s) => `${s.scene}(${Object.keys(s.wxFields ?? {}).length})`);
    // 2026-11-19：cutoff_remind / building_suspend_fulfill / building_suspend_refund
    // 曾是单字段，后台校验必报「多一个关键词」、真投递 47003。补成两段式后应全绿。
    expect(bad).toEqual([]);
  });

  it('wxFields 的业务键必须在 WX_BIZ_FIELD_LABEL 里有中文名（后台展示用）', () => {
    const missing: string[] = [];
    for (const s of MESSAGE_TEMPLATE_SPECS) {
      for (const bizKey of Object.keys(s.wxFields ?? {})) {
        if (!WX_BIZ_FIELD_LABEL[bizKey]) missing.push(`${s.scene}.${bizKey}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('groupContent 里的 {{变量}} 必须在 variables 白名单内', () => {
    const bad = MESSAGE_TEMPLATE_SPECS.filter(
      (s) => findUnknownVariables(s.seed.groupContent, s.variables).length > 0,
    ).map((s) => s.scene);
    expect(bad).toEqual([]);
  });

  it('requestSubscribe=true 的场景必须已接线（索权却不用是平台明确反对的行为）', () => {
    const bad = MESSAGE_TEMPLATE_SPECS.filter((s) => s.requestSubscribe && s.wiring !== 'live').map(
      (s) => s.scene,
    );
    expect(bad).toEqual([]);
  });

  /**
   * 开团通知（`group_open`）的专属约束
   *
   * 这些数字不是随便定的：**2 个关键词**是微信公共模板库的下限（运营勾 1 个点不了提交，
   * 2026-11-18 已为此纠过一次错），而 `time` 类型自带日期 ⇒ 不能也不需要再塞 `date`。
   */
  describe('group_open（团长开团通知）', () => {
    const spec = MESSAGE_TEMPLATE_SPECS.find((s) => s.scene === 'group_open');

    it('场景存在且已接线', () => {
      expect(spec).toBeDefined();
      expect(spec?.wiring).toBe('live');
    });

    it('双渠道：订阅消息 + 微信群兜底（一次性订阅额度有限，必须留兜底）', () => {
      expect(spec?.channels).toEqual(['wechat_subscribe', 'wechat_group']);
    });

    it('关键词恰好 2 个（微信下限），且是公共模板真实编号 thing5 + time2', () => {
      const wx = spec?.wxFields ?? {};
      expect(Object.keys(wx)).toHaveLength(2);
      // 2026-11-19：适配祝总选的公共模板「团长开团通知」（团购名称=thing5、开始时间=time2）
      expect(Object.values(wx).sort()).toEqual(['thing5', 'time2']);
    });

    it('种子未启用 —— 缺模板 ID 时启用闸门必须拦住', () => {
      const state = specState(spec!);
      expect(state.enabled).toBe(0);
      const missing = missingForEnable(spec!, state);
      // 订阅消息渠道缺模板 ID（群渠道的文案已在种子里，故只有一条）
      expect(missing.length).toBe(1);
      expect(missing[0]).toContain(CHANNEL_REQUIREMENT.wechat_subscribe.fieldLabel);
    });

    it('未启用时不给用户端返回可授权模板（不索要一个不会用的授权）', () => {
      expect(subscribeTemplateOf(spec!, specState(spec!))).toBeNull();
    });
  });

  /**
   * 团长激活三件套（2026-11-18 第二批）
   *
   * 这四个场景结构统一：都是 2 个关键词（事物/结果 + 时间），便于运营申请模板时少记规则。
   * ⚠️ 编号按各自真实模板实配：前三行 `thing1` + `time2`；`withdraw_result` 因祝总申请到的
   * 公共模板编号不同，2026-11-19 改为 `phrase3` + `time1`（关键词池固有位置，不随勾选顺序变）。
   * 把「每行各自的编号」写成断言，改动或换模板时立刻被拦下，避免生产投递 `47003`。
   */
  describe('团长激活三件套（晋级 / 到期预警 / 停职 / 提现结果）', () => {
    const SCENES = ['leader_promoted', 'trainee_expiring', 'leader_suspended', 'withdraw_result'];

    it('四个场景都存在且已接线（声明了却不接线 = 索权不用）', () => {
      for (const scene of SCENES) {
        const spec = MESSAGE_TEMPLATE_SPECS.find((s) => s.scene === scene);
        expect(spec).toBeDefined();
        expect(spec?.wiring).toBe('live');
        expect(spec?.requestSubscribe).toBe(true);
      }
    });

    it('全部双渠道 —— 一次性订阅额度有限，必须留群兜底', () => {
      for (const scene of SCENES) {
        const spec = MESSAGE_TEMPLATE_SPECS.find((s) => s.scene === scene);
        expect(spec?.channels).toEqual(['wechat_subscribe', 'wechat_group']);
      }
    });

    it('每行恰好 2 个关键词，编号与各自真实模板对齐（前三 thing1+time2 / 提现 phrase3+time1）', () => {
      // 前三行沿用统一编号
      for (const scene of ['leader_promoted', 'trainee_expiring', 'leader_suspended']) {
        const wx = MESSAGE_TEMPLATE_SPECS.find((s) => s.scene === scene)?.wxFields ?? {};
        expect(Object.keys(wx)).toHaveLength(2);
        expect(Object.values(wx).sort()).toEqual(['thing1', 'time2']);
      }
      // 提现结果：祝总实际申请到的公共模板编号（2026-11-19 校验 47003 后实测确认）
      const wxWithdraw =
        MESSAGE_TEMPLATE_SPECS.find((s) => s.scene === 'withdraw_result')?.wxFields ?? {};
      expect(Object.keys(wxWithdraw)).toHaveLength(2);
      expect(Object.values(wxWithdraw).sort()).toEqual(['phrase3', 'time1']);
    });

    it('全部种子未启用 —— 缺模板 ID 时启用闸门必须拦住', () => {
      for (const scene of SCENES) {
        const spec = MESSAGE_TEMPLATE_SPECS.find((s) => s.scene === scene)!;
        const state = specState(spec);
        expect(state.enabled).toBe(0);
        const missing = missingForEnable(spec, state);
        expect(missing.length).toBe(1);
        expect(missing[0]).toContain(CHANNEL_REQUIREMENT.wechat_subscribe.fieldLabel);
      }
    });

    it('晋级文案必须点明「佣金比例」—— 涨钱才是这条通知的意义', () => {
      const spec = MESSAGE_TEMPLATE_SPECS.find((s) => s.scene === 'leader_promoted');
      expect(spec?.seed.groupContent).toContain('佣金');
      // 变量白名单里必须有费率，否则运营拿到的群文案会漏掉最关键的那个数字
      expect(spec?.variables).toContain('rateText');
    });

    it('停职文案必须给出复职出路 —— 只说「你被停职了」等于宣布出局', () => {
      const spec = MESSAGE_TEMPLATE_SPECS.find((s) => s.scene === 'leader_suspended');
      expect(spec?.seed.groupContent).toContain('申请');
      expect(spec?.seed.groupContent).toContain('保留');
    });

    it('提现结果文案必须能区分「驳回」与「打款失败」的下一步', () => {
      const spec = MESSAGE_TEMPLATE_SPECS.find((s) => s.scene === 'withdraw_result');
      // 模板本身用占位符承载结果，判据是「不把两种失败写死成同一句话」
      expect(spec?.seed.groupContent).toContain('{{noticeTitle}}');
      expect(spec?.trigger).toContain('驳回');
      expect(spec?.trigger).toContain('打款失败');
    });
  });
});
