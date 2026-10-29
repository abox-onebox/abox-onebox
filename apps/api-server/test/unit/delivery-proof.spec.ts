import {
  DEFAULT_DELIVERY_PROOF_KIND,
  DELIVERY_PROOF_KINDS,
  DELIVERY_PROOF_URL_MAX,
  checkProofUrl,
  isProofKind,
  normalizeProofKind,
  proofKindText,
} from '../../src/common/constants/delivery-proof';

/**
 * Q3 送达凭证判据单测
 *
 * 自证要求（恒绿或恒红的检查等于没有检查）：
 * ① 必过的样本**必须过**（否则判据恒红，会把正常上传全拦下来）；
 * ② 必报的样本**必须报**（否则判据恒绿，等于没校验）；
 * ③ 每种拒绝理由**各自**被覆盖到（否则「非空」这一条挂了，可能只是被长度那条挡住而已，
 *    看起来仍然「拒绝成功」—— 假绿）。
 */
describe('checkProofUrl', () => {
  const OK: Array<[string, string]> = [
    ['站内路径', '/static/uploads/2026-10-29/abc.jpg'],
    ['https 绝对地址', 'https://cdn.example.com/proof/a.png'],
    ['http 绝对地址', 'http://img.example.com/a.jpg'],
    ['带查询串', 'https://cdn.example.com/a.jpg?x=1&y=2'],
    ['首尾空白会被 trim', '  /static/a.jpg  '],
  ];

  it.each(OK)('必过：%s', (_label, raw) => {
    const r = checkProofUrl(raw);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.url).toBe(raw.trim());
  });

  const BAD: Array<[string, string, string]> = [
    ['空串', '', '不能为空'],
    ['纯空白', '   ', '不能为空'],
    ['非字符串', 123 as unknown as string, '必须是字符串'],
    ['超长', `/static/${'a'.repeat(DELIVERY_PROOF_URL_MAX)}`, '长度不能超过'],
    ['javascript 协议', 'javascript:alert(1)', '站内 /static/'],
    ['data URI', 'data:image/png;base64,AAAA', '站内 /static/'],
    ['含换行', '/static/a.jpg\nX-Evil: 1', '控制字符'],
    ['含制表符', '/static/a.jpg\tb', '控制字符'],
    ['相对路径', 'static/a.jpg', '站内 /static/'],
    ['裸域名', 'cdn.example.com/a.jpg', '站内 /static/'],
  ];

  it.each(BAD)('必报：%s', (_label, raw, reasonFragment) => {
    const r = checkProofUrl(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain(reasonFragment);
  });

  it('③ 每条拒绝理由都被独立覆盖（不是被另一条挡住而假绿）', () => {
    // 「非空」这一条：用一个**长度合法**的空串去触发，确保不是被长度判据挡下的
    expect(checkProofUrl('').ok).toBe(false);
    // 「长度」这一条：用一个**形态合法**的超长串，确保不是被形态判据挡下的
    const longButShaped = `/static/${'a'.repeat(DELIVERY_PROOF_URL_MAX)}.jpg`;
    const r = checkProofUrl(longButShaped);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('长度');
    // 「形态」这一条：用一个**长度与字符都合法**的串
    const r2 = checkProofUrl('cdn.example.com/a.jpg');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.reason).toContain('站内 /static/');
  });

  it('边界：恰好 512 字符放行，513 拒绝', () => {
    const at = `/static/${'a'.repeat(DELIVERY_PROOF_URL_MAX - 8)}`;
    expect(at.length).toBe(DELIVERY_PROOF_URL_MAX);
    expect(checkProofUrl(at).ok).toBe(true);
    expect(checkProofUrl(`${at}a`).ok).toBe(false);
  });
});

describe('kind 归一化', () => {
  it('合法值原样保留，且三个值都在允许集合内', () => {
    for (const k of DELIVERY_PROOF_KINDS) {
      expect(isProofKind(k)).toBe(true);
      expect(normalizeProofKind(k)).toBe(k);
    }
  });

  it('非法 / 缺失 → 缺省值（不报错：类型只是标签，不该拦住上传）', () => {
    expect(normalizeProofKind(undefined)).toBe(DEFAULT_DELIVERY_PROOF_KIND);
    expect(normalizeProofKind(null)).toBe(DEFAULT_DELIVERY_PROOF_KIND);
    expect(normalizeProofKind('PHOTO')).toBe(DEFAULT_DELIVERY_PROOF_KIND);
    expect(normalizeProofKind('receipt')).toBe(DEFAULT_DELIVERY_PROOF_KIND);
    expect(normalizeProofKind(42)).toBe(DEFAULT_DELIVERY_PROOF_KIND);
  });

  it('文案：已知值有中文，未知值原样返回（老数据出现新值时显示原文更好排查）', () => {
    expect(proofKindText('photo')).toBe('现场照');
    expect(proofKindText('sign')).toBe('签收单');
    expect(proofKindText('other')).toBe('其它');
    expect(proofKindText('new_kind')).toBe('new_kind');
  });
});
