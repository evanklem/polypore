#!/usr/bin/env python3
"""tmux capture-pane -e output -> a self-contained HTML page sized to the grid.

usage: ansi2html.py <in.ansi> <out.html> <cols> <rows> [bg] [fg]
"""
import html, re, sys

src, dst, cols, rows = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
BG = sys.argv[5] if len(sys.argv) > 5 else "#1d1813"
FG = sys.argv[6] if len(sys.argv) > 6 else "#e8dcc4"

BASE = ["#1d1f21", "#cc6666", "#b5bd68", "#f0c674", "#81a2be", "#b294bb", "#8abeb7", "#c5c8c6",
        "#666666", "#d54e53", "#b9ca4a", "#e7c547", "#7aa6da", "#c397d8", "#70c0b1", "#eaeaea"]


def c256(n):
    if n < 16:
        return BASE[n]
    if n < 232:
        n -= 16
        v = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (v[n // 36], v[(n // 6) % 6], v[n % 6])
    g = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (g, g, g)


text = open(src, encoding="utf-8", errors="replace").read()
lines = text.split("\n")[:rows]

st = dict(fg=None, bg=None, b=False, d=False, i=False, u=False, rev=False)
out_rows = []
tok = re.compile(r"\x1b\[([0-9;:]*)m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|([^\x1b]+)")


def span(s, chars):
    fg, bg = st["fg"] or FG, st["bg"]
    if st["rev"]:
        fg, bg = (st["bg"] or BG), (st["fg"] or FG)
    css = [f"color:{fg}"]
    if bg:
        css.append(f"background:{bg}")
    if st["b"]:
        css.append("font-weight:700")
    if st["d"]:
        css.append("opacity:.6")
    if st["i"]:
        css.append("font-style:italic")
    if st["u"]:
        css.append("text-decoration:underline")
    body = "".join(html.escape(ch) if ord(ch) < 128 else f'<i class="c">{html.escape(ch)}</i>' for ch in chars)
    return f'<span style="{";".join(css)}">{body}</span>'


for line in lines:
    parts = []
    for m in tok.finditer(line):
        if m.group(2) is not None:
            parts.append(span(st, m.group(2)))
            continue
        if m.group(1) is None:
            continue
        ps = [p for p in re.split(r"[;:]", m.group(1))] or ["0"]
        k = 0
        while k < len(ps):
            p = int(ps[k] or 0)
            if p == 0:
                st.update(fg=None, bg=None, b=False, d=False, i=False, u=False, rev=False)
            elif p == 1: st["b"] = True
            elif p == 2: st["d"] = True
            elif p == 3: st["i"] = True
            elif p == 4: st["u"] = True
            elif p == 7: st["rev"] = True
            elif p == 22: st["b"] = st["d"] = False
            elif p == 23: st["i"] = False
            elif p == 24: st["u"] = False
            elif p == 27: st["rev"] = False
            elif 30 <= p <= 37: st["fg"] = BASE[p - 30]
            elif 90 <= p <= 97: st["fg"] = BASE[p - 90 + 8]
            elif 40 <= p <= 47: st["bg"] = BASE[p - 40]
            elif 100 <= p <= 107: st["bg"] = BASE[p - 100 + 8]
            elif p == 39: st["fg"] = None
            elif p == 49: st["bg"] = None
            elif p in (38, 48):
                key = "fg" if p == 38 else "bg"
                mode = int(ps[k + 1] or 0) if k + 1 < len(ps) else 0
                if mode == 2 and k + 4 < len(ps):
                    r, g, b_ = (int(x or 0) for x in ps[k + 2:k + 5])
                    st[key] = "#%02x%02x%02x" % (r, g, b_)
                    k += 4
                elif mode == 5 and k + 2 < len(ps):
                    st[key] = c256(int(ps[k + 2] or 0))
                    k += 2
            k += 1
    out_rows.append("".join(parts) or " ")

FONT_PX = 15
LH = 19
page = f"""<!doctype html><meta charset="utf-8"><style>

html,body {{ margin:0; background:{BG}; }}
pre {{ margin:0; padding:14px 16px; font: {FONT_PX}px/{LH}px "CaskaydiaMono NFM", "CaskaydiaMono Nerd Font Mono", monospace; color:{FG};
       white-space:pre; font-variant-ligatures:none; }}
.r {{ height:{LH}px; overflow:hidden; }}
.c {{ display:inline-block; width:1ch; text-align:center; font-style:normal; overflow:visible; }}
</style><pre>{"".join(f'<div class="r">{r}</div>' for r in out_rows)}</pre>"""
open(dst, "w").write(page)
