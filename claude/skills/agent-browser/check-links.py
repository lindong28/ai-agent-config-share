#!/usr/bin/env python3
"""agent-browser skill 的引用完整性检查。

  BARE  — 裸同文件锚点，对每个文件都查（只查 SKILL.md 会漏掉随内容搬迁带过去的锚点）
  CROSS — 跨文件锚点，解析到目标文件自己的标题
  PROSE — `Option N` 形式的正文引用，在同文件没有对应标题时报出。这一类只覆盖
          `Option N` 这一种命名法，不是通用的"散文点名死标题"检查

用法：cd claude/skills/agent-browser && python3 check-links.py
退出码 1 表示有 broken reference。
"""
import re, pathlib, sys

def slugs(txt):
    return {re.sub(r'[^a-z0-9\- ]', '', m.group(1).lower()).strip().replace(' ', '-')
            for m in re.finditer(r'^#+ (.+)$', txt, re.M)}

files = {p: p.read_text(encoding='utf-8')
         for p in [pathlib.Path('SKILL.md'), *sorted(pathlib.Path('references').glob('*.md'))]}
own = {p: slugs(t) for p, t in files.items()}
bad = []
for p, txt in files.items():
    for m in re.finditer(r'\]\(#([a-z0-9\-]+)\)', txt):
        if m.group(1) not in own[p]:
            bad.append(f"BARE   {p} -> #{m.group(1)}")
    for m in re.finditer(r'\]\((?:\.\./)?((?:references/)?[A-Za-z0-9\-_.]+\.md)#([a-z0-9\-]+)\)', txt):
        cand = [q for q in files if q.name == m.group(1).split('/')[-1]]
        if cand and m.group(2) not in own[cand[0]]:
            bad.append(f"CROSS  {p} -> {m.group(1)}#{m.group(2)}")
    for m in re.finditer(r'\b(Option\s+\d+)\b', txt):
        if not re.search(rf'^#+ .*{re.escape(m.group(1))}', txt, re.M):
            bad.append(f"PROSE  {p} -> mentions '{m.group(1)}' with no such heading")
for b in sorted(set(bad)):
    print("  " + b)
print(f"\n{len(set(bad))} broken references")
sys.exit(1 if bad else 0)
