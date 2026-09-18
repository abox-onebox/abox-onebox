# -*- coding: utf-8 -*-
"""
生成 ABox 楷体子集字体（woff2）。
字符集 = GB2312 一级汉字（3755 常用字）+ ASCII 可打印 + 常用中文标点 + 源码里出现过的全部 CJK 字符。
产出: apps/miniprogram/src/static/fonts/ab-kaiti.woff2
"""
import os, subprocess, sys

ROOT = r"C:\Users\herma\WorkBuddy\ABox小程序\abox-onebox"
SRC = os.path.join(ROOT, "apps", "miniprogram", "src")
FONT = r"C:\Windows\Fonts\simkai.ttf"
OUT_DIR = os.path.join(SRC, "static", "fonts")
OUT = os.path.join(OUT_DIR, "ab-kaiti.woff2")
CHARS_TXT = os.path.join(ROOT, "scripts", "ab-kaiti-chars.txt")  # 放 scripts/ 而非 src/static/，避免被打进产物

chars = set()

# 1) ASCII 可打印
chars.update(chr(c) for c in range(0x20, 0x7F))

# 2) GB2312 一级汉字：高字节 B0-D7，低字节 A1-FE
for hi in range(0xB0, 0xD8):
    for lo in range(0xA1, 0xFF):
        try:
            chars.update(bytes([hi, lo]).decode("gb2312"))
        except UnicodeDecodeError:
            pass

# 3) 常用中文标点 / 符号
chars.update("，。、；：？！“”‘’（）《》〈〉【】〔〕·—…％¥℃°×÷±≤≥≠∞～｜　")
chars.update("七八九十百千万亿零壹贰叁肆伍陆柒捌玖拾佰仟万亿")

# 4) 源码（vue/ts/scss/json）里出现过的全部 CJK 字符 —— 兜底动态文案之外的一切写死文字
for dirpath, dirnames, filenames in os.walk(SRC):
    if "node_modules" in dirpath:
        continue
    for fn in filenames:
        if fn.endswith((".vue", ".ts", ".scss", ".css", ".json")):
            p = os.path.join(dirpath, fn)
            try:
                text = open(p, encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            chars.update(ch for ch in text if ord(ch) > 0x7F and not ch.isspace())

# 去掉 fontTools 不喜欢的控制区
chars = sorted(ch for ch in chars if 0x20 <= ord(ch) != 0x7F)

os.makedirs(OUT_DIR, exist_ok=True)
with open(CHARS_TXT, "w", encoding="utf-8") as f:
    f.write("".join(chars))
print(f"字符集: {len(chars)} 个字符 → {CHARS_TXT}")

cmd = [
    sys.executable, "-m", "fontTools.subset", FONT,
    f"--text-file={CHARS_TXT}",
    "--flavor=woff2",
    f"--output-file={OUT}",
    "--layout-features=",
    "--no-hinting",
    "--desubroutinize",
]
r = subprocess.run(cmd, capture_output=True, text=True)
if r.returncode != 0:
    print(r.stdout[-800:]); print(r.stderr[-800:]); sys.exit(1)

size = os.path.getsize(OUT)
print(f"产出: {OUT}")
print(f"体积: {size/1024:.0f} KB（原字体 11.2 MB 的 {size/11787312*100:.1f}%）")
assert size < 3 * 1024 * 1024, "子集超过 3MB，字符集异常"
print("OK")
