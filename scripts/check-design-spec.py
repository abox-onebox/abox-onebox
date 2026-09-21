# -*- coding: utf-8 -*-
"""UI 门禁 —— 把《设计系统 v2.1》§五 / §八 / §九 的设计红线做成机械判据。

⚠️ 自带自证（`--selftest`）：会人为构造「必报样本」与「必不报样本」各一份，
   任一判据在自证里表现不符即视为**判据本身坏了**（恒绿或恒红的检查等于没有检查）。

⚠️ 2026-09-21（S9）：本脚本由 `_tmp/icons/ui-gate.py` 迁入仓库 `scripts/` 并纳入
   **常驻门禁**（`node scripts/gate.mjs design:spec`）。

   迁入原因（实证）：它当时**不在任何门禁内**，`gate.mjs all verify` 覆盖不到。
   S8 把后台侧栏菜单抽成共享组件后，其中一条断言仍去旧文件里找旧字面量 ⇒ **转红**，
   而**红了三轮无人发现** —— 手工脚本的断言会悄悄过期，这正是「恒红 = 没有检查」。
   迁入同时把路径改为**按脚本位置解析**（原先硬编码工作区根的绝对路径，
   换机 / CI 里直接跑不起来）。本脚本**只读仓库内源码**（apps/*/src + vite.config.ts），
   不依赖工作区根文档 ⇒ 在 CI 里同样有效。

⚠️ 2026-09-21（S9）再补：新增第 8 / 9 道闸门 —— **窄屏触摸目标 44px 的落点**
   （§9.2 汉堡 / §9.3 工具栏与卡片内控件 / §9.4 状态四按钮）。此前只查了「窄屏块**存在**」，
   而 390px 真视口实测证明：汉堡与窄屏按钮确是 44px，但**工具栏下拉 32px、卡片里的链接
   输入框 32px、状态四按钮 30px**（Element Plus 默认值）—— 「存在」对「达标」完全无感。
   存在 ≠ 达标。断言的是**真正生效**的 wrapper 规则，不是「看着合理」的 CSS 变量：
   EP 2.14 的 `.el-select__wrapper` 写死 `min-height: 32px`，设 `--el-component-size` 抬不动它。

用法:
    python scripts/check-design-spec.py            # 跑门禁
    python scripts/check-design-spec.py --selftest # 只跑自证
"""
import re
import sys
from pathlib import Path

# ⚠️ 按**脚本自身位置**解析仓库根 —— 不要硬编码工作区根绝对路径。
#   本脚本位于 `<repo>/scripts/`，故 repo = parent.parent；WS 仅用于报告里显示相对路径。
REPO = Path(__file__).resolve().parent.parent
WS = REPO.parent
MP = REPO / "apps/miniprogram/src"
AW = REPO / "apps/admin-web/src"

# ---------------- 基础工具 ----------------

def codepoint_class(*ranges: tuple[int, int]) -> str:
    """⚠️ 用 chr() 拼装码位区间，**不要**手写 \\UXXXXXXXX 字面量：
    实测 `"\\U000002600-..."` 少写一位会被 Python 取前 8 位（U+0260），
    区间变成 U+0260–U+27BF，把大半个 BMP 吞成 emoji（误报 82 万处）。"""
    return "".join(f"{chr(a)}-{chr(b)}" for a, b in ranges)


# emoji 完整区段（与 P0 规则一致）
EMOJI = re.compile(
    "["
    + codepoint_class(
        (0x1F300, 0x1F9FF), (0x2600, 0x26FF), (0x2700, 0x27BF),
        (0xFE00, 0xFE0F), (0x1F000, 0x1F02F), (0x1F0A0, 0x1F0FF),
        (0x1F100, 0x1F2FF), (0x1F680, 0x1F6FF), (0x1FA00, 0x1FA6F),
        (0x1FA70, 0x1FAFF), (0x200D, 0x200D), (0x20E3, 0x20E3),
        (0xE0020, 0xE007F),
    )
    + "]"
)

# 裸色值：允许 #fff / #000（P0 明文豁免）；token 定义文件内的色值合法
BARE_HEX = re.compile(r"#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b")
TOKEN_FILES = {"tokens.scss", "tokens.ts", "design-tokens.json", "runtime-colors.ts"}
HEX_EXEMPT = {"#fff", "#000", "#ffffff", "#000000"}

# 状态原色：只许用于图标与描边，**不许**作文字色（S5 缺陷③）
# ⚠️ 左边界 `(?<![-\w])` 不可省：否则 `border-color: $c-warning;` 里的 `color` 会被子串误命中
#    （实测：「状态原色作描边」这条不动脑就会恒红）。同理排除 background-color / text-color。
STATE_ORIGINALS = ["$c-success", "$c-warning", "$c-info", "$c-gold"]
COLOR_STATE = re.compile(r"(?<![-\w])color\s*:\s*(\$c-(?:success|warning|info|gold))\s*;")

# 紫粉渐变 / 弹跳缓动 / 空洞文案（P0-2 / P0-3）
PURPLE = re.compile(r"linear-gradient\([^)]*#(?:7C3AED|A855F7|EC4899|6366F1)", re.I)
BOUNCE = re.compile(r"cubic-bezier\(\s*0?\.68\s*,\s*-0?\.55")
EMPTY_COPY = re.compile(r"Lorem ipsum|Welcome to (?:Our|the) App|Sign up today", re.I)

# 功能图标三档 / 装饰插图四档（规格 §五）
ICON_SIZES = {16, 20, 24}
ILLUS_SIZES = {14, 28, 34, 40}
# 团长等级四档（=`abl`/LeaderLevel 的取值）
LEVELS = ("trainee", "formal", "gold", "chief")


def strip_comments(text: str, is_vue: bool) -> str:
    """屏蔽注释区，但**等长替换为空格**（保留换行）⇒ 字符偏移不变 ⇒ 行号可精确回溯。

    ⚠️ 踩过的四个坑，缺一条判据就会失真：
    ① **偏移必须守恒** —— 早先版本用 `re.sub` 直接删注释，剥完字符串短了一截，
       于是 `txt.count("\\n", 0, m.start())` 拿「剥后下标」去数「原文行号」——
       实测把 `ab-icon/index.vue` 的命中报到第 17 行（真实第 9 行），行号全是错的。
    ② **字符串里的 `//` 不算注释** —— 否则 `'https://x'` 会被当注释起点。
    ③ **.vue 还要剥 HTML 注释** —— 模板里的说明文字是注释不是渲染区，
       不剥会把注释里的告警符号误记成「渲染区 emoji」，白跑一轮。
    ④ **必须是「有序状态机」而非「先标字符串再剥注释」两遍法** ——
       两遍法在注释里出现**奇数个反引号**时，会把其后整段真代码误标成字符串 ⇒
       注释剥不掉 ⇒ **假阴性**（漏报，比误报更危险）。
       从左到右一次走完，状态只见当前上下文：进了块注释，反引号就不再是字符串起点。

    返回：与原文**等长**的字符串，注释区被空格覆盖（换行保留）。
    """
    out = list(text)
    n = len(text)
    i = 0
    while i < n:
        if is_vue and text.startswith("<!--", i):
            j = text.find("-->", i + 4)
            j = n if j < 0 else j + 3
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        elif text.startswith("/*", i):
            j = text.find("*/", i + 2)
            j = n if j < 0 else j + 2   # 未闭合按到文件尾
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        elif text.startswith("//", i):
            j = text.find("\n", i + 2)
            j = n if j < 0 else j
            for k in range(i, j):
                if out[k] != "\n":
                    out[k] = " "
            i = j
        elif text[i] in "\"'`":
            q = text[i]
            j = i + 1
            while j < n:
                if text[j] == "\\":
                    j += 2
                    continue
                if text[j] == q:
                    break
                j += 1
            i = j + 1
        else:
            i += 1
    return "".join(out)


def outer_template_span(text: str):
    """返回顶层 `<template>…</template>` 的**内层**区间 (start, end)；按深度配平。

    ⚠️ 不能用非贪婪正则 `/<template[^>]*>(.*?)<\\/template>/s` —— 它会在**第一个**
    `</template>` 处截断（`<template v-else>` 这类嵌套极常见）。实测 `withdraw.vue`
    只扫到 1128/12145 字符，**漏掉 7 处** ⇒ 假阴性（漏报比误报危险，本项目已踩过）。
    """
    m = re.search(r"<template(?:\s[^>]*)?>", text)
    if not m:
        return None
    i, depth = m.end(), 1
    tag = re.compile(r"<(/?)template(?:\s[^>]*)?>")
    while depth:
        t = tag.search(text, i)
        if not t:
            return None
        depth += -1 if t.group(1) else 1
        i = t.end()
    return m.end(), t.start()


def brace_at(txt: str, start: int):
    """从 `start` 起找到第一个 `{`，按**深度配平**抽到配对的 `}`（含两端括号）。

    只取到「下一个 `}`」会踩两个坑：① 嵌套规则（`&__inner { … }`）会提前截断 ⇒ 假阴性；
    ② 块缺失时无法与「找到了但内容不符」区分 ⇒ 无法自曝。
    """
    i = txt.find("{", start)
    if i < 0:
        return None
    depth, j = 0, i
    while j < len(txt):
        if txt[j] == "{":
            depth += 1
        elif txt[j] == "}":
            depth -= 1
            if depth == 0:
                return txt[i : j + 1]
        j += 1
    return None


def narrow_touch_defects(txt: str, need_radio: bool = False):
    """窄屏触摸目标落点：§9.2 汉堡 44px · §9.3 工具栏控件 44px · §9.4 状态四按钮 44px。

    ⚠️ 判据基于**取值**且先剥注释 —— 写进注释的 `--el-component-size: 44px` 不算数
    （本仓库已两次踩到「注释里引用旧值反而触发 / 绕过判据」）。
    ⚠️ 为什么查 `--el-component-size` 而不是 `min-height`：EP 控件高度来自它自己的尺寸变量；
       只给**容器** min-height 会得到「外框 44 / 控件本体 32」——机械过检、观感已坏。

    返回 [(行号, 说明)]；行号为 0 表示锚点（窄屏块）本身没找到。
    """
    spans = []
    for m in re.finditer(r"\.ab-layout\.is-narrow\s*\{", txt):
        ln = txt.count("\n", 0, m.start()) + 1
        spans.append((ln, brace_at(txt, m.start()) or "{"))
    if not spans:
        return [(0, "找不到 `.ab-layout.is-narrow` 窄屏块（锚点失效须自曝，不得静默恒绿）")]
    body = strip_comments("\n".join(b for _, b in spans), True)
    ref = spans[0][0]
    bad = []
    # ⚠️ 断言的是**真正生效**的那两条：EP 2.14 的 `.el-select__wrapper` 写死 `min-height: 32px`
    #    不吃任何变量；输入框虽走 `--el-component-size`，但显式 wrapper 规则更稳（不受
    #    EP 版本换实现影响）。早先版本断言 `--el-component-size` ⇒ 实测**抬不动下拉**（假绿）。
    if not re.search(r"\.el-select__wrapper[^{]*\{[^}]*min-height:\s*44px", body):
        bad.append((ref, "窄屏块内 `.el-select__wrapper` 缺 `min-height: 44px`（下拉本体仍 EP 默认 32px）"))
    if not re.search(r"\.el-input__wrapper[^{]*\{[^}]*min-height:\s*44px", body):
        bad.append((ref, "窄屏块内 `.el-input__wrapper` 缺 `min-height: 44px`（输入框本体仍 EP 默认 32px）"))
    if need_radio and not re.search(r"&__inner\s*\{[^}]*min-height:\s*44px", body, re.S):
        bad.append((ref, "窄屏块内 `.el-radio-button__inner` 缺 `min-height: 44px`（状态四按钮 EP 实测 30px）"))
    return bad


def narrow_touch_hits(rel: str, need_radio: bool = False):
    """把 `narrow_touch_defects` 包成 gate() 需要的 `(path, line, msg)` 三元组。"""
    p = AW / rel
    if not p.exists():
        return [(p, 0, "文件不存在（判据锚点丢失）")]
    return [(p, ln, msg) for ln, msg in narrow_touch_defects(p.read_text(encoding="utf-8"), need_radio)]


def check_md_emphasis(corpus):
    """模板**渲染区**里不得出现 Markdown 强调（`**X**` 会被原样渲染成星号）。

    ⚠️ 判据两条要点：
    ① **先剥 HTML 注释**（`strip_comments`，等长替换 ⇒ 行号可回溯）——
       注释由渲染层剥掉、**不渲染**。本轮实测：全仓模板区 22 处 `**` 里 **15 处在注释内**，
       若一并计入，口径会从「真需修 7 处」虚高到「17 处 / 8 文件」。
    ② **按深度抽 `<template>`**（见 `outer_template_span`），否则嵌套截断 ⇒ 漏报。
    """
    hits = []
    for p, txt in corpus:
        if p.suffix != ".vue":
            continue
        span = outer_template_span(txt)
        if not span:
            continue
        a, _b = span
        clean = strip_comments(txt[a:_b], True)
        for m in re.finditer(r"\*\*[^*\n]+?\*\*", clean):
            hits.append((p, txt.count("\n", 0, a + m.start()) + 1, m.group(0)))
    return hits


def iter_src(root: Path, exts=(".vue", ".ts", ".js", ".scss", ".css")):
    for p in sorted(root.rglob("*")):
        if p.is_file() and p.suffix in exts and "node_modules" not in p.as_posix():
            yield p


# ---------------- 判据集合 ----------------

def check_emoji(corpus):
    hits = []
    for p, txt in corpus:
        body = strip_comments(txt, p.suffix == ".vue")
        for m in EMOJI.finditer(body):
            hits.append((p, txt.count("\n", 0, m.start()) + 1, "U+%04X" % ord(m.group())))
    return hits


def check_bare_hex(corpus):
    hits = []
    for p, txt in corpus:
        if p.name in TOKEN_FILES:
            continue
        # 产物/图标基（base64 里天然含十六进制串）不算
        if "icons.scss" in p.name:
            continue
        body = strip_comments(txt, p.suffix == ".vue")
        for m in BARE_HEX.finditer(body):
            v = m.group().lower()
            if v in HEX_EXEMPT:
                continue
            hits.append((p, txt.count("\n", 0, m.start()) + 1, v))
    return hits


def load_tokens() -> dict:
    """解析 `tokens.scss` 里的 `$name: #hex;`（端上 / 后台同名同值，实测一致）。"""
    m = {}
    for app in ("miniprogram", "admin-web"):
        p = REPO / f"apps/{app}/src/styles/tokens.scss"
        if p.exists():
            for mm in re.finditer(r"^\$([\w-]+)\s*:\s*(#[0-9a-fA-F]{3,8})\s*;",
                                  p.read_text(encoding="utf-8"), re.M):
                m.setdefault(mm.group(1), mm.group(2).lower())
    return m


def check_state_color_as_text(corpus, tokens=None):
    """状态**原值**作文字色 → 缺陷；但若它与自己的 `-fg` 加强档**同值**，则只是命名问题，不计缺陷。

    ⚠️ 不能按名字硬报：实测 `$c-info` 与 `$c-info-fg` **都是 #4a6fa5**（同值），
    这种用法改不改渲染一模一样 —— 硬报就是**噪音**，而噪音会让门禁被无视（比漏报更致命）。
    真正要拦的是「原色对比度不够却拿去当文字」⇒ 判据就该判这个：
    把 tokens.scss 里两档的实际值取出来比一比，**不同值才报**。

    返回 (缺陷, 同值计数)。
    """
    tokens = {} if tokens is None else tokens
    hits, same = [], 0
    for p, txt in corpus:
        body = strip_comments(txt, p.suffix == ".vue")
        for m in COLOR_STATE.finditer(body):
            name = m.group(1)[1:]                      # 去掉前导 $
            v, fg = tokens.get(name), tokens.get(name + "-fg")
            if v and fg and v == fg:
                same += 1
                continue
            hits.append((p, txt.count("\n", 0, m.start()) + 1, m.group(1)))
    return hits, same


def check_icon_size(corpus):
    """功能图标尺寸锁三档：承载组件的 size 只许 16/20/24（规格 §五）。

    ## S9 修正（原判据恒 N/A）

    原实现写死 kebab-case `<ab-icon\b…size="N"` ⇒ 本仓库 **0 样本** ⇒ 常驻报 N/A。
    但真实承载一直存在：**后台** `apps/admin-web/src/components/AbIcon/index.vue`
    （`size?: 16 | 20 | 24`，默认 20）实测 **13 处**引用 ⇒ 原判据**一处都没扫到**。
    「恒 N/A」与「恒绿」同罪 —— 都等于没有检查。现按真实承载改写（两种写法都收）。

    ⚠️ 必须**锚定标签名**：同批 `.vue` 里还有 `<el-empty :image-size="48|56|60">`
    （Element 空状态插图，与三档无关）。只按 `size="N"` 裸扫会把它们误判成第四档。

    ## 端上为什么不在这里扫（刻意不重复实现）

    端上功能图标不是组件调用，而是 `<text class="abi abi-16">` 字符承载
    （`components/ab-icon/` 已按裁定移出仓库，0 引用）。它的三档锁由**专用门禁**
    `icons:lock`（`scripts/check-icon-lock.mjs`）覆盖 —— 同一判据写两遍，
    就会出现「改一处、另一处悄悄失真」，那正是本项目 `dup:const` 门禁要治的病。

    返回：(hits, samples)。samples 单独回报，0 样本由 gate() 降级为 N/A。
    """
    hits, seen = [], 0
    # 两种等价写法都收：静态 `size="16"` 与绑定 `:size="16"`（`\bsize` 在 `:` 之后亦成立）
    pat = re.compile(r"""<(?:AbIcon|ab-icon)\b[^>]*?\bsize\s*=\s*["'](\d+)["']""", re.S)
    for p, txt in corpus:
        for m in pat.finditer(txt):
            seen += 1
            if int(m.group(1)) not in ICON_SIZES:
                hits.append((p, txt.count("\n", 0, m.start()) + 1, m.group(1)))
    return hits, seen

def tier_defects(txt: str):
    """（纯函数，便于自证）`icons.scss` 内容 → 档位定义缺陷清单。"""
    found = sorted({int(m.group(1)) for m in re.finditer(r"\.abi-(\d+)\s*\{", txt)})
    want = [16, 20, 24]                       # 以 px 命名、以 rpx 落地
    bad = []
    if found != want:
        bad.append(("档位集合不符", 0, f"实得={found} 期望={want}"))
    for n, rpx in ((16, 32), (20, 40), (24, 48)):
        if not re.search(rf"\.abi-{n}\s*\{{\s*font-size:\s*{rpx}rpx", txt):
            bad.append((f"档位 {n}px 的 rpx 值不对", 0, f"期望 font-size: {rpx}rpx"))
    return bad


def tl_dot_defects(txt: str):
    """（纯函数，便于自证）`order-detail.vue` 内容 → 时间线圆点缺陷清单。

    ⚠️ 本判据早先是**无定位子串** `"width: 30rpx" in od` —— 实测该串在改动前后两个版本里
       **都不存在**（原始圆点 18rpx、S7.5 后 36rpx）⇒ 断言**恒红**，与「恒绿」同罪：等于没有检查。
       （`width: 30rpx` 全文件 0 命中，唯一的 `30rpx` 是 `.tl__line` 的 `top: 30rpx`。）
    ⇒ 现改为**定位到 `.tl__dot` 块内**取值，并按大括号配平取块（防止被嵌套规则截断）。
    """
    m = re.search(r"&__dot\s*\{", txt)
    if not m:
        return [("找不到 .tl__dot 块", 0, "选择器 `&__dot {`")]
    i = txt.index("{", m.start())
    depth, j = 0, i
    while j < len(txt):
        if txt[j] == "{":
            depth += 1
        elif txt[j] == "}":
            depth -= 1
            if depth == 0:
                break
        j += 1
    blk = txt[i:j]
    ln = txt.count("\n", 0, i) + 1
    bad = []
    if not re.search(r"width:\s*30rpx", blk):
        bad.append(("圆点非 15px（规格 §八）", ln, "期望 `.tl__dot` 块内 `width: 30rpx`"))
    if not re.search(r"height:\s*30rpx", blk):
        bad.append(("圆点高度非 15px", ln, "期望 `.tl__dot` 块内 `height: 30rpx`"))
    return bad


def check_icon_tiers():
    """档位定义闸门：`icons.scss` 里只许存在 .abi + 三档（32/40/48rpx），不许冒出第四档。

    这是「三档锁定」**真正拦得住人**的那一条 —— 它扫的是定义处，不是用法处，永远有样本。
    """
    p = MP / "styles/icons.scss"
    if not p.exists():
        return [("icons.scss 缺失", 0, str(p))]
    return tier_defects(p.read_text(encoding="utf-8"))


def check_theme(corpus):
    hits = []
    for p, txt in corpus:
        for rx, tag in ((PURPLE, "紫粉渐变"), (BOUNCE, "弹跳缓动"), (EMPTY_COPY, "空洞文案")):
            for m in rx.finditer(txt):
                hits.append((tag, p, txt.count("\n", 0, m.start()) + 1))
    return hits


def check_spec_landing():
    """S6 组件规格的**落点存在性**——防「文档写了、代码没做」。"""
    facts = {}

    def read(p: Path) -> str:
        return p.read_text(encoding="utf-8") if p.exists() else ""

    # ① 端上等级徽标组件（四档形态齐备）
    # ⚠️ 断言必须用**源码真实写法**：SCSS 走嵌套 `&--trainee`，模板走动态类名 `` `ab-level--${level}` ``
    #    ——早先版本断言字面量 `ab-level--trainee`，这两个文件里根本不存在这种字符串，
    #    于是「文档写了、代码也做了」却**门禁报 FAIL**（假红，同样让判据失信）。
    lb = read(MP / "components/ab-level-badge/index.vue")
    facts["端上 ab-level-badge 动态类名"] = "`ab-level--${level}`" in lb
    facts["端上 ab-level-badge 四档样式"] = all(f"&--{k}" in lb for k in LEVELS)
    # 描边款必须自带底色（否则 #936f3a 压在米色底只有 4.05）
    facts["等级徽标描边款自带底色"] = lb.count("background: $c-surface") >= 2

    # ② 后台等级徽标样式（四档）+ 不再有等级四色当文字
    lvscss = read(AW / "styles/level-badge.scss")
    facts["后台 level-badge.scss 四档"] = all(f"&--{k}" in lvscss for k in LEVELS)
    dead = [
        p for p in AW.rglob("*.vue")
        if "levelTagType" in p.read_text(encoding="utf-8")
    ]
    facts["后台 levelTagType 已清零"] = not dead

    # ③ 空状态装饰插图（34px 通道）+ 各处已配
    es = read(MP / "components/ab-empty-state/index.vue")
    facts["空状态插图 34px"] = "font-size: 68rpx" in es
    facts["空状态插图走 AboxIconName"] = "AboxIconName" in es

    # ④ 时间线三态（端上）
    od = read(MP / "pages/order-detail/order-detail.vue")
    facts["时间线三态 dotState"] = "dotState" in od
    # ⚠️ 定位断言（早先是**无定位子串** ⇒ 恒红，见 tl_dot_defects 文档串）
    facts["时间线节点 15px（定位 .tl__dot）"] = not tl_dot_defects(od)
    # 圆形容器内字形走**装饰档**（与 avatar__icon / level__icon / grid__icon 同族约定）
    facts["时间线勾用装饰档 abi-deco-28"] = "abi-deco-28 tl__dot-ico" in od

    # ⑤ 状态 chip：色调底 + 加强档（端上无 rgba 手写）
    sb = read(MP / "components/ab-status-badge/index.vue")
    facts["状态 chip 无手写 rgba"] = not re.search(r"rgba\(\s*\d+\s*,\s*\d+", sb)
    facts["状态 chip 用加强档"] = "$c-ok-fg" in sb and "$c-warn-fg" in sb

    # ⑥ 后台 Element 覆盖：源码层只能查**写法**（是否写了同优先级选择器）；
    #    真正「有没有生效」必须验产物 ⇒ `_tmp/icons/verify-dist-css.py`（自证 + 14 项）
    eo = read(AW / "styles/element-override.scss")
    facts["el-tag 覆盖存在"] = "--el-tag-text-color: #{$c-ok-fg}" in eo
    # ⚠️ 只写 `.el-tag--success`（0,1,0）打不过 Element 的 `.el-tag.el-tag--success`（0,2,0），
    #    位置再靠后也不生效 —— 实测踩过，源码层全绿 / 浏览器里全是旧样式。
    facts["el-tag 覆盖与 Element 同优先级"] = ".el-tag.el-tag--" in eo
    facts["el-steps 未到态文字已修"] = ".el-step__head.is-wait" in eo
    # Element 原规则同时在设 border-color ⇒ 只改 color 不够，等待态圆环仍是 #a8abb2
    facts["el-steps 等待态描边已修"] = bool(
        re.search(r"\.el-step__head\.is-wait\s*\{[^}]*border-color", eo)
    )
    # el-alert 正文：Element 写作 `.is-light`（0,3,0）⇒ 覆盖必须带 .is-light
    facts["el-alert 正文色已归位"] = ".el-alert--success.is-light" in eo
    # 状态色浅色阶：只覆盖基色不覆盖 light-N ⇒ 所有浅色底组件跑出米金色系
    facts["状态色浅色阶已重算"] = (
        eo.count("-light-9:") >= 6 and "--el-color-error:" in eo
    )

    # ⑦ 按需样式必须关闭（否则 chunk css 会在运行时覆盖上面全部覆盖）
    vc = read(REPO / "apps/admin-web/vite.config.ts")
    facts["Element 按需样式已关闭"] = vc.count("importStyle: false") >= 2

    # ⑧ S7：菜单 icon 全覆盖 + 侧边栏渲染 + 死组件清零
    #
    # ⚠️ 这里只做**粗糙计数**兜底（条目数 == icon 数）；精确的名字同源校验
    #    在 `scripts/check-nav-consistency.mjs` 第 ⑥ 条（它是项目原有门禁，随 gate.mjs 跑）。
    #    两处都留，是因为本脚本可在改完设计后**单独秒跑**，不必等整套 gate。
    nav = read(AW / "constants/index.ts")
    n_items = len(re.findall(r"path:\s*'", nav))
    n_icons = len(re.findall(r"icon:\s*'", nav))
    facts[f"菜单 icon 全覆盖（{n_icons}/{n_items}）"] = n_items > 0 and n_icons == n_items

    # ⑨ S8 起菜单抽成**单一共享组件**（桌面侧栏 + 窄屏抽屉各挂一次）。
    #     ⚠️ 早先这里查 layout 里的字面量 `class="ab-layout__ico"`：S8 把菜单外移后该串
    #        消失 ⇒ 断言**转红**，且因脚本不在 gate.mjs 内而**无人发现**。
    #     ⇒ 改为**按语义定位**：菜单组件必须用 `<AbIcon :name="it.icon">` 消费 icon 字段 ——
    #        查的是「有没有渲染」而不是「类名叫什么」。类名会随重构变，语义不会。
    nav_menu = AW / "layouts/ab-nav-menu.vue"
    layout = read(AW / "layouts/default-layout.vue")
    nm = read(nav_menu) if nav_menu.exists() else ""
    facts["侧边栏菜单渲染 AbIcon（消费 icon 字段）"] = "<AbIcon" in nm and ':name="it.icon"' in nm
    # 菜单项布局（图标 + 文字对齐）在共享组件里，不在 layout 里 —— 查错文件会
    # 「为错误的原因而通过」（layout 里的 flex 是 header/侧栏容器布局，与菜单项无关）。
    facts["菜单项布局为 flex（共享组件内）"] = "display: flex" in nm
    # 共用实现：layout 必须把**同一个**菜单组件挂两处（桌面侧栏 + 窄屏抽屉）。
    # 否则「加入口只改一处」的约定会静默失效 —— 两份实现必然漂移，而
    # `nav:consistency` 校验的是**真源**，看不见「渲染了几遍」。
    facts["菜单两处共用同一组件（桌面 / 窄屏）"] = layout.count("<AbNavMenu") >= 2

    dead_dirs = [
        "apps/miniprogram/src/components/ab-countdown",
        "apps/miniprogram/src/components/ab-dish-card",
        "apps/miniprogram/src/components/ab-meal-card",
        "apps/admin-web/src/components/chart",
        "apps/admin-web/src/components/editor",
        "apps/admin-web/src/components/search-form",
        "apps/admin-web/src/components/table",
        "apps/admin-web/src/components/upload",
    ]
    left = [d for d in dead_dirs if (REPO / d).exists()]
    facts[f"死组件目录已清零（{len(dead_dirs) - len(left)}/{len(dead_dirs)}）"] = not left

    return facts


# ---------------- 自证 ----------------

def selftest():
    print("=" * 66)
    print("自证：判据必须「该报的报、该不报的不报」")
    print("=" * 66)
    fails = []

    def case(name, got, want):
        ok = got == want
        if not ok:
            fails.append(name)
        print(f"  {'OK  ' if ok else 'FAIL'} {name}  实得={got} 期望={want}")

    # ① emoji
    case("应报：注释外的 emoji",
         len(check_emoji([(Path("t.vue"), "<text>\U0001F600</text>")])), 1)
    case("不报：注释内的 emoji",
         len(check_emoji([(Path("t.vue"), "// 说明 \U000026A0 保留\n<text>x</text>")])), 0)
    case("不报：字符串里的注释符不误剥",
         len(check_emoji([(Path("t.vue"), "<text>{{ '// not a comment \U0001F600' }}</text>")])), 1)

    # ② 裸 hex
    case("应报：裸 hex", len(check_bare_hex([(Path("a.vue"), "color:#123456;")])), 1)
    case("不报：#fff 豁免", len(check_bare_hex([(Path("a.vue"), "color:#fff;")])), 0)
    case("不报：tokens.scss 内合法", len(check_bare_hex([(Path("tokens.scss"), "$c:#123456;")])), 0)

    # ③ 状态原色作文字（判据按**取值**判，不按名字判）
    TOK = {"c-warning": "#b4762a", "c-warning-fg": "#7a5218",
           "c-info": "#4a6fa5", "c-info-fg": "#4a6fa5",        # 同值：模拟真实 tokens
           "c-gold": "#c9a876", "c-gold-fg": "#936f3a"}

    def _s3(txt):
        return check_state_color_as_text([(Path("a.vue"), txt)], TOK)

    case("应报：原色当文字（两档不同值）", len(_s3(".x{color: $c-warning;}")[0]), 1)
    case("应报：金色原色当文字（1.98 必报）", len(_s3(".x{color: $c-gold;}")[0]), 1)
    case("不报：原色作描边", len(_s3(".x{border-color: $c-warning;}")[0]), 0)
    case("不报：原色作底色", len(_s3(".x{background-color: $c-gold;}")[0]), 0)
    case("不报：原色与 -fg 同值（$c-info ≡ $c-info-fg，改了渲染也一样）",
         len(_s3(".x{color: $c-info;}")[0]), 0)
    case("计数：同值用法计入 advisory", _s3(".x{color: $c-info;}")[1], 1)

    # ④ 图标尺寸（S9 修：原判据写死 kebab-case `<ab-icon`，而本仓库真实承载是
    #    后台 PascalCase `<AbIcon>`（13 处引用）⇒ 全仓 0 样本、常驻报 N/A。）
    h4, seen4 = check_icon_size([(Path("a.vue"), '<AbIcon name="warn-tri" size="18" />')])
    case("应报：后台 <AbIcon> 第四档（原 kebab 判据漏扫 PascalCase 承载）",
         (len(h4), seen4), (1, 1))
    h5, seen5 = check_icon_size([(Path("a.vue"), '<AbIcon :name="it.icon" :size="24" />')])
    case("不报：<AbIcon> 绑定写法合规（`:size` 同样计入样本）", (len(h5), seen5), (0, 1))
    h6, seen6 = check_icon_size([(Path("a.vue"), '<ab-icon name="check" size="20" />')])
    case("不报：kebab 旧写法仍被识别（向后兼容）", (len(h6), seen6), (0, 1))
    h7, seen7 = check_icon_size([(Path("a.vue"), '<el-empty :image-size="60" />')])
    case("不报且不计样本：EP 空状态 `:image-size` 不属三档（判据必须锚定标签）",
         (len(h7), seen7), (0, 0))
    case("应报：档位定义冒出第四档",
         len(tier_defects(".abi-16{font-size:32rpx;}.abi-20{font-size:40rpx;}"
                          ".abi-24{font-size:48rpx;}.abi-32{font-size:64rpx;}")), 1)
    case("不报：档位定义恰三档且 rpx 正确",
         len(tier_defects(".abi-16 { font-size: 32rpx; }\n.abi-20 { font-size: 40rpx; }\n"
                          ".abi-24 { font-size: 48rpx; }")), 0)
    case("应报：档位 rpx 值写错",
         len(tier_defects(".abi-16 { font-size: 30rpx; }\n.abi-20 { font-size: 40rpx; }\n"
                          ".abi-24 { font-size: 48rpx; }")), 1)

    # ⑤ 主题红线
    case("应报：紫粉渐变",
         len(check_theme([(Path("a.scss"), "background:linear-gradient(135deg,#7C3AED,#EC4899);")])), 1)
    case("应报：弹跳缓动",
         len(check_theme([(Path("a.scss"), "transition:all .3s cubic-bezier(0.68, -0.55, 0.265, 1.55);")])), 1)
    case("不报：正常缓动",
         len(check_theme([(Path("a.scss"), "transition:all .2s ease-out;")])), 0)

    # ⑥ 注释屏蔽（偏移守恒 / HTML 注释 / 有序状态机）
    h = check_emoji([(Path("t.vue"), "// \U0001F600 注释行\n<text>\U0001F600</text>")])
    case("行号：剥注释不挪行（偏移守恒）", (len(h), h[0][1] if h else 0), (1, 2))
    case("不报：HTML 注释里的 emoji",
         len(check_emoji([(Path("t.vue"), "<!-- \U000026A0 说明 -->\n<text>x</text>")])), 0)
    case("不报：注释里出现奇数反引号后，注释仍剥净",
         len(check_emoji([(Path("t.vue"), "/* 见 `foo 字段 */\n<text>x</text>")])), 0)
    case("不误吞：注释后真代码仍被扫到",
         len(check_emoji([(Path("t.vue"), "/* ` */\n<text>\U0001F600</text>")])), 1)
    case("不误吞：字符串里的 '/*' 不吞后续代码",
         len(check_emoji([(Path("t.vue"), "<text>{{ '/*' }}</text>\n<text>\U0001F600</text>")])), 1)

    # ⑦ 时间线圆点（**定位**断言 —— 早先是无定位子串，实测恒红）
    case("应报：圆点 36rpx（非规格 15px）",
         len(tl_dot_defects("&__dot {\n  width: 36rpx;\n  height: 36rpx;\n}")), 2)
    case("不报：圆点 30rpx（规格 15px）",
         len(tl_dot_defects("&__dot {\n  width: 30rpx;\n  height: 30rpx;\n}")), 0)
    case("不误报：嵌套规则里的 36rpx 不影响外层判定",
         len(tl_dot_defects(
             "&__dot {\n  width: 30rpx;\n  height: 30rpx;\n  &.is-done {\n    border: 36rpx;\n  }\n}")), 0)
    case("应报：找不到 .tl__dot 块（锚点失效须自曝，不得静默恒绿）",
         len(tl_dot_defects("&__line { width: 30rpx; }")), 1)

    case("应报：模板**文本节点**里的 Markdown 强调",
         len(check_md_emphasis([(Path("t.vue"),
             "<template>\n  <p>注意**此处**要加粗</p>\n</template>")])), 1)
    case("不报：HTML 注释里的 Markdown 强调（注释不渲染）",
         len(check_md_emphasis([(Path("t.vue"),
             "<template>\n  <!-- 注意**此处**要加粗 -->\n</template>")])), 0)
    case("应报：嵌套 </template> 之后的强调也扫得到（深度配平）",
         len(check_md_emphasis([(Path("t.vue"),
             "<template>\n  <template v-else><p>a</p></template>\n  <p>**漏检点**</p>\n</template>")])), 1)

    # ⑧ 窄屏触摸目标落点（S9 补记：§9.2 / §9.3 / §9.4）
    BOTH = ":deep(.el-select__wrapper), :deep(.el-input__wrapper) { min-height: 44px; }"
    case("应报：窄屏块整体缺失（锚点失效须自曝）",
         len(narrow_touch_defects(".toolbar { align-items: stretch; }")), 1)
    case("应报：窄屏块内两条 wrapper 规则都缺",
         len(narrow_touch_defects(".ab-layout.is-narrow { .toolbar { align-items: stretch; } }")), 2)
    case("不报：两条 wrapper 规则都到位",
         len(narrow_touch_defects(".ab-layout.is-narrow { " + BOTH + " }")), 0)
    case("应报：只抬了下拉、漏了输入框（卡片里的输入框就是这么漏掉的）",
         len(narrow_touch_defects(
             ".ab-layout.is-narrow { :deep(.el-select__wrapper) { min-height: 44px; } }")), 1)
    case("应报：注释里的 44px 不算数（剥注释后判）",
         len(narrow_touch_defects(
             ".ab-layout.is-narrow { .toolbar { // .el-select__wrapper { min-height: 44px; }\n} }")), 2)
    case("应报：需要状态按钮达标时缺 min-height",
         len(narrow_touch_defects(".ab-layout.is-narrow { " + BOTH + " }", need_radio=True)), 1)
    case("不报：状态按钮 min-height 已就位",
         len(narrow_touch_defects(
             ".ab-layout.is-narrow { " + BOTH
             + " .el-radio-button { &__inner { min-height: 44px; } } }", need_radio=True)), 0)
    case("不误报：外层两条 wrapper 不能顶替状态按钮那条",
         len(narrow_touch_defects(
             ".ab-layout.is-narrow { " + BOTH
             + " .el-radio-button { &__inner { min-height: 30px; } } }", need_radio=True)), 1)

    print()
    if fails:
        print(f"自证不通过 ❌ 失效判据={fails}")
        return 1
    print("自证通过 ✅ —— 判据本身可信，门禁结果才有意义")
    return 0


# ---------------- 主流程 ----------------

def main():
    if "--selftest" in sys.argv:
        return selftest()

    rc = selftest()
    if rc:
        return rc

    corpus = [(p, p.read_text(encoding="utf-8", errors="ignore"))
              for p in iter_src(MP)]
    corpus += [(p, p.read_text(encoding="utf-8", errors="ignore"))
               for p in iter_src(AW)]

    print()
    print("=" * 66)
    print(f"UI 门禁（语料：端上 + 后台源码，共 {len(corpus)} 个文件）")
    print("=" * 66)

    fail = 0
    na = 0

    def gate(no, name, hits, samples=None, detail=True):
        """samples=None → 无样本概念的闸门；给了样本数且为 0 → 记 N/A。

        ⚠️ 0 样本**绝不能记 OK** —— 那是「恒绿」，等于没有检查（实测吃过这个亏：
        `<ab-icon size>` 判据在本仓库语料里一个样本都扫不到，却一直报绿）。
        """
        nonlocal fail, na
        if samples == 0:
            na += 1
            print(f"  N/A  {no:>2}. {name}  样本=0 —— 判据未生效，不计入通过")
            return
        ok = not hits
        if not ok:
            fail += 1
        tail = f"  命中={len(hits)}" + (f" · 样本={samples}" if samples is not None else "")
        print(f"  {'OK  ' if ok else 'FAIL'} {no:>2}. {name}{tail}")
        if hits and detail:
            for h in hits[:8]:
                loc = h[0].relative_to(REPO).as_posix() if isinstance(h[0], Path) else str(h[0])
                print(f"        {loc}:{h[1]}  {h[2]}")
            if len(hits) > 8:
                print(f"        … 其余 {len(hits) - 8} 处")

    def fact(name, ok):
        nonlocal fail
        if not ok:
            fail += 1
        print(f"  {'OK  ' if ok else 'FAIL'} {name}")

    gate(1, "emoji 零（渲染区 · 剥注释后）", check_emoji(corpus))
    gate(2, "裸色值归零（#fff/#000 豁免）", check_bare_hex(corpus))
    s3_hits, s3_same = check_state_color_as_text(corpus, load_tokens())
    gate(3, "状态原色不作文字色（与原值不同才算）", s3_hits)
    if s3_same:
        print(f"        · 另有 {s3_same} 处「原值与 -fg 同值」的用法（命名不统一，无对比度风险）")
    gate(4, "功能图标尺寸锁三档（后台 `<AbIcon>` / `<ab-icon>` 用法）", *check_icon_size(corpus))
    gate(5, "图标档位定义恰三档 16/20/24px = 32/40/48rpx", check_icon_tiers())
    gate(6, "紫粉渐变 / 弹跳缓动 / 空洞文案", check_theme(corpus))
    # ⚠️ 必须上报**样本数**（扫到多少个 `<template>` 的 .vue）：否则「一个模板都没扫到」
    #    会显示成「0 命中」被读作通过 —— 那正是恒绿。样本为 0 时 gate() 记 N/A 并排除出分母。
    md_scope = sum(1 for p, t in corpus if p.suffix == ".vue" and "<template" in t)
    gate(7, "模板渲染区内的 Markdown 强调（剥注释 · 深度配平抽 template）",
         check_md_emphasis(corpus), md_scope)
    # ⚠️ 样本数 = 1（本闸门只看这 1 个文件）；文件缺失时 narrow_touch_hits 返回命中 ⇒ 转红，
    #    不会因为「扫不到」而静默变绿。
    gate(8, "窄屏触摸目标 · takeout-links（§9.3 工具栏控件 44px）",
         narrow_touch_hits("views/supplier/takeout-links.vue"), 1)
    gate(9, "窄屏触摸目标 · commission（§9.3 控件 + §9.4 状态按钮 44px）",
         narrow_touch_hits("views/finance/commission.vue", True), 1)

    print("  ---- 规格落点存在性（防「文档写了、代码没做」）----")
    for k, v in check_spec_landing().items():
        fact(k, v)

    print()
    total = 9 + len(check_spec_landing())   # 9 道扫描闸门 + 落点事实条目
    passed = total - fail - na
    print(f"门禁结果：{passed}/{total} 通过"
          + (f"（另 {na} 项无样本 · 判据未生效，不计入分母）" if na else "")
          + ("  ✅" if not fail else "  ❌"))
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
