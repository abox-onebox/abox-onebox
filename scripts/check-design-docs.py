# -*- coding: utf-8 -*-
"""设计文档链门禁 —— 判「源 → 镜像 → 产物」三件事。

目的：把设计文档（规格稿 / 执行清单 / 登记册）的**红线与结构**，以及
      《本地开发手册》的**工作区根 ↔ docs/ 镜像一致性**，做成机械判据。

⚠️ 与 `_tmp/dsg/verify-regen.py` 的关系（**刻意只取一部分**）：
   那个脚本是 S6/S7 那一次重生成的**一次性批次验收**，含 6 处**冻死的数字**
   （39 个菜单入口 / 22 处 8 文件 / 登记册 24,610 字节 …）。把冻死数字挂成常驻
   门禁 ⇒ **一有合理变更就恒红**，与「恒绿」同罪，都是「等于没有检查」。
   ⇒ 冻死数字留在一次性脚本里；常驻门禁只留**不随批次漂移**的判据。
     登记册亦不再冻字节数，改判**结构**（表头 + 状态列取值域）。

⚠️ 作用域（决定了它**不进 `all` 别名**）：设计文档带 `_` 前缀 = 工作区内部物料，
   `sync-docs.mjs` **刻意不镜像**（例：`_ABox一盒人工测试入口卡v1.0.html` 含内网 IP）。
   ⇒ CI 的 checkout 里**没有这些语料**，若挂在 `all` 里就是「CI 装作绿」——
     而那正是本项目 `ci.yml` 注释里点名要根治的病。
   本地一键：`node scripts/gate.mjs design`（= design:spec + design:docs）。

⚠️ 自带自证：判据必须「该报的报、该不报的不报」，否则恒绿 / 恒红都等于没检查。
   自证里**专门验一次「1 字节漂移能否被抓到」** —— 那正是本批实测出来的真缺陷
   （手册源 `all=20` / 镜像 `all=21`，两侧字节数相同、只有 1 个字节不同）。
"""
import hashlib
import re
import sys
import tempfile
from pathlib import Path

# ⚠️ 按**脚本自身位置**解析仓库根（本脚本在 <repo>/scripts/）；不要硬编码工作区根绝对路径。
REPO = Path(__file__).resolve().parent.parent
WS = REPO.parent
DOCS = REPO / "docs"

SPEC_NAME = "_ABox一盒设计系统v2.1规格.html"
CLIST_NAME = "_ABox一盒设计替换执行清单v1.0.md"
OPEN_NAME = "_ABox一盒悬而未决登记册.md"
MANUAL_NAME = "ABox一盒本地开发手册v1.0.md"

# ⚠️ 用 chr() 拼装码位区间，**不要**手写 `\UXXXXXXXX` 字面量：
#   实测踩过 —— `"\U000002600-..."` 少一位会写成 9 位十六进制，Python 只取前 8 位
#   （U+0260），于是区间变成 U+0260–U+27BF，把大半个 BMP 都吞成「emoji」，误报 82 万处。
_R = [
    (0x1F300, 0x1F9FF), (0x2600, 0x26FF), (0x2700, 0x27BF), (0xFE00, 0xFE0F),
    (0x1F000, 0x1F02F), (0x1F0A0, 0x1F0FF), (0x1F100, 0x1F64F), (0x1F680, 0x1F6FF),
    (0x1F900, 0x1F9FF), (0x1FA00, 0x1FA6F), (0x1FA70, 0x1FAFF),
    (0x200D, 0x200D), (0x20E3, 0x20E3), (0xE0020, 0xE007F),
]
EMOJI = re.compile("[" + "".join(f"{chr(a)}-{chr(b)}" for a, b in _R) + "]")

# ⚠️ 作用域（2026-09-21 更正）：P0 红线是「**UI 功能图标**不得用 emoji」，
#    不是「任何 emoji 字符都不得出现」。本项目全部 `_ABox*` 文档都在用 ✅/⚠️ 作标注
#    （里程碑计划 87/167、接口规范 17/117、冻结清单 4/113）⇒ 约定是「文档可用标注符号」。
#    原 `verify-regen.py` 把代码红线直接套到 .md 上 ⇒ **恒红 3 轮无人发现**。
#    正确写法 = 按作用域判：只放行这三个标注符号 + VS16（变体选择符），象形 emoji 仍须为 0。
DOC_MARKS = {"\u26A0", "\u2705", "\u274C", "\uFE0F"}

fails = []


def chk(name, cond, detail=""):
    print(f"  {'OK  ' if cond else 'FAIL'} {name}{('  ' + detail) if detail else ''}")
    if not cond:
        fails.append(name)


def digest(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def pick(name: str):
    """文档定位：**工作区根优先**（权威源），缺失才回落 `docs/` 镜像。

    ⚠️ 必须把「用了哪一侧」打出来 —— 否则在 CI 里静默改用镜像、与本地区别对待，
       而报告上看不出任何差别（「同一件事两份表述」的典型病根）。
    """
    for side, base in (("工作区根", WS), ("docs/ 镜像", DOCS)):
        p = base / name
        if p.exists():
            return p, side
    return None, None


def selftest() -> int:
    print("=" * 66)
    print("自证：判据必须「该报的报、该不报的不报」")
    print("=" * 66)
    bad = []

    def case(name, got, want):
        if got != want:
            bad.append(name)
        print(f"  {'OK  ' if got == want else 'FAIL'} {name}  实得={got} 期望={want}")

    # ① emoji 正则：象形必报 / 常规字符必不报
    case("应报：象形 emoji", bool(EMOJI.match("\U0001F371")), True)
    case("应报：⚠（U+26A0）", bool(EMOJI.search("\u26A0")), True)
    case("不报：中文 / 字母 / 全角波浪", any(EMOJI.search(c) for c in "中A～"), False)

    # ② 文档口径作用域：放行标注符号、仍拦象形
    case("应报：文档里的象形 emoji", ("\U0001F371" in DOC_MARKS), False)
    case("不报：文档里的 ⚠/✅/❌", all(c in DOC_MARKS for c in "\u26A0\u2705\u274C"), True)

    # ③ 镜像判据：**1 字节漂移必须能被抓到**（本批实测出的真缺陷就是这个形状：
    #    两侧字节数相同、只有 1 个字节不同 ⇒ `diff` 看不出、只有摘要能看出）
    with tempfile.TemporaryDirectory() as td:
        a, b = Path(td) / "a", Path(td) / "b"
        a.write_bytes(b"all=20\n")
        b.write_bytes(b"all=20\n")
        case("不报：两侧逐字节相同", digest(a) == digest(b), True)
        b.write_bytes(b"all=21\n")
        case("应报：仅 1 字节不同", digest(a) != digest(b), True)

    print()
    if bad:
        print(f"自证不通过 ❌ 失效判据={bad}")
        return 1
    print("自证通过 ✅ —— 判据本身可信，门禁结果才有意义")
    return 0


def main() -> int:
    if selftest():
        return 1

    print()
    print("=" * 66)
    print("设计文档链门禁（规格稿 / 执行清单 / 登记册 + 手册源↔镜像）")
    print("=" * 66)

    # ── ① 文档定位 ────────────────────────────────────────────────────
    docs = {}
    for name in (SPEC_NAME, CLIST_NAME, OPEN_NAME):
        p, side = pick(name)
        docs[name] = p
        print(f"  · {name}  → {side or '**未找到**'}")
    missing = [n for n, p in docs.items() if p is None]
    chk("三份设计文档均可定位", not missing, f"缺失 {missing}" if missing else "")
    if missing:
        print(f"\n结果: 不通过 ❌ {fails}")
        return 1

    spec = docs[SPEC_NAME].read_text(encoding="utf-8")
    clist = docs[CLIST_NAME].read_text(encoding="utf-8")
    opn = docs[OPEN_NAME].read_text(encoding="utf-8")

    # ── ② 规格 HTML：P0 红线 + 结构完整性 ─────────────────────────────
    print("\n  ---- 规格 HTML ----")
    n_emoji = len(EMOJI.findall(spec))
    chk("象形 emoji 0 处（P0 红线）", n_emoji == 0, f"实得 {n_emoji}")
    chk("紫粉渐变 0 处", "linear-gradient(135deg,#7C3AED" not in spec)
    chk("<table> 配平", spec.count("<table") == spec.count("</table>"),
        f"{spec.count('<table')} / {spec.count('</table>')}")
    chk("<div> 配平", spec.count("<div") == spec.count("</div>"),
        f"{spec.count('<div')} / {spec.count('</div>')}")
    chk("字体 base64 在位", "data:font/woff2;base64,d09GMg" in spec)
    chk("</html> 恰 1 处（未被截断）", spec.count("</html>") == 1, f"实得 {spec.count('</html>')}")
    # 下限而非定值：防「生成器中途失败产出半截文件」。定值会随内容合理增长而恒红。
    chk("字节数在下限之上（防半截产物）", len(spec.encode("utf-8")) > 50_000,
        f"实得 {len(spec.encode('utf-8')):,}")

    # ── ③ 执行清单：文档口径（作用域）────────────────────────────────
    print("\n  ---- 执行清单 MD ----")
    hits = [m.group() for m in EMOJI.finditer(clist)]
    pict = sorted({c for c in hits if c not in DOC_MARKS})
    chk("象形 emoji 0 处（文档只放行 ⚠/✅/❌ + VS16）", not pict,
        f"实得 {len(pict)} 种 {pict[:5]}" if pict else f"标注符号 {len(hits)} 处，全部合规")
    chk("结构锚点在位（§十 判据更正 / §十二 回滚）",
        "## 十、" in clist and "## 十二、" in clist)
    n_sec = len(re.findall(r"(?m)^## ", clist))
    chk("章节数 >= 10（防整段丢失）", n_sec >= 10, f"实得 {n_sec}")
    chk("字节数在下限之上（防半截产物）", len(clist.encode("utf-8")) > 10_000,
        f"实得 {len(clist.encode('utf-8')):,}")

    # ── ④ 登记册：结构（不冻字节数）──────────────────────────────────
    print("\n  ---- 悬而未决登记册 ----")
    HEADER = "| 日期 | 来源 | 未决项 | 关联约束 | 当前倾向 | 卡在什么上 | 何时可定 | 状态 |"
    chk("表头在位", HEADER in opn)
    # ⚠️ 逐行解析**整张表**，而不是「正则能匹配上的那些行」——
    #    后者会**静默跳过**取值异常的行（例如状态误写成 `OPEN（等他定）`），
    #    于是「异常行」永远不被任何断言看见 = 恒绿。判据必须能看见**每一行**。
    lines = opn.splitlines()
    idx = next((i for i, l in enumerate(lines) if l.strip() == HEADER), None)
    STATES = ("OPEN", "RESOLVED", "SUPERSEDED")
    parsed, bad_rows, emphasized = [], [], 0
    if idx is not None:
        for l in lines[idx + 2:]:  # +2：跳过表头行与分隔行
            if not l.lstrip().startswith("|"):
                break
            raw = l.strip().strip("|").split("|")[-1].strip()
            cell = raw.strip("*").strip()  # 去掉 Markdown 强调再判语义
            if raw != cell:
                emphasized += 1
            parsed.append(cell)
            if cell not in STATES:
                bad_rows.append(raw)
    chk("状态列取值域合法（且无行被静默跳过）",
        idx is not None and bool(parsed) and not bad_rows,
        f"共 {len(parsed)} 行 · 非法取值 {bad_rows[:3]}" if bad_rows else f"共 {len(parsed)} 行")
    # ⚠️ 判据只判**语义**（去掉 `**` 后是否属于取值域），不判**呈现** ——
    #    禁止加粗会让门禁变脆：未来有人把某行状态写成 `**RESOLVED**`（更醒目）就会无端恒红，
    #    那是「脆门禁」而不是「真缺陷」。呈现差异改为**可见但不失败**的信息。
    if emphasized:
        print(f"        · 另有 {emphasized} 行状态带 Markdown 强调（`**RESOLVED**`）——"
              " 不影响判定；同表混用两种写法，建议下次编辑时统一")
    n_open = parsed.count("OPEN")
    n_res = parsed.count("RESOLVED")
    chk("登记册有据可查（至少 1 条留痕）", n_open + n_res >= 1,
        f"OPEN {n_open} · RESOLVED {n_res} · 字节 {len(opn.encode('utf-8')):,}")

    # ── ⑤ 源 ↔ 镜像（sync-docs.mjs 的契约）──────────────────────────
    print("\n  ---- 源 ↔ docs/ 镜像 ----")
    src_p, mir_p = WS / MANUAL_NAME, DOCS / MANUAL_NAME
    if src_p.exists() and mir_p.exists():
        same = digest(src_p) == digest(mir_p)
        chk("手册源↔镜像逐字节一致（sha256）", same,
            "" if same else f"源={digest(src_p)[:12]} 镜像={digest(mir_p)[:12]}"
            + " ⇒ 请跑 `pnpm docs:sync` 后重试（注意：源是权威，先改源）")
    else:
        # CI checkout 里工作区根不存在，只有镜像 —— 明示为**无法比对**，不记 OK（不装作绿）
        print(f"  N/A  手册源↔镜像一致性  源存在={src_p.exists()} 镜像存在={mir_p.exists()}"
              " —— 无法比对，不计入通过")
    leaked = sorted(p.name for p in DOCS.glob("_ABox一盒*"))
    chk("工作区内部物料（`_` 前缀）未进镜像", not leaked,
        f"误入 {leaked}" if leaked else f"docs/ 共 {len(list(DOCS.glob('ABox一盒*')))} 份契约文档")
    for p in DOCS.glob("ABox一盒*"):
        if p.is_file():
            m = re.search(r"<!--\s*gate-count:\s*all=(\d+)\s+verify=(\d+)\s*-->", p.read_text(encoding="utf-8"))
            if m:
                print(f"  · 镜像 {p.name} 的条数标记：all={m.group(1)} verify={m.group(2)}"
                      "（其权威校验在 `gate:parity`）")

    print(f"\n结果: {'全部通过 ✅' if not fails else '不通过 ❌ ' + str(fails)}")
    return 0 if not fails else 1


if __name__ == "__main__":
    raise SystemExit(main())
