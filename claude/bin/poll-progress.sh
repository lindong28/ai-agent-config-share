#!/usr/bin/env bash
# poll-progress.sh — incremental tail reader for a codeagent-wrapper background task .output
# Usage: poll-progress.sh <output-file> [max-lines]
set -euo pipefail
file="${1:?usage: poll-progress.sh <output-file> [max-lines]}"
max="${2:-80}"
cursor="${file}.progress-cursor"

if [[ ! -f "$file" ]]; then
  echo "[poll-progress] waiting: ${file} 尚未创建" >&2
  exit 0
fi

total="$(wc -l < "$file" | tr -d ' ')"
prev=0
[[ -f "$cursor" ]] && prev="$(tr -d ' ' < "$cursor" 2>/dev/null || echo 0)"
[[ "$prev" =~ ^[0-9]+$ ]] || prev=0

if (( total <= prev )); then          # 无新增；文件意外变短(total<prev)也归此自愈
  echo "[poll-progress] 无新增（共 ${total} 行）"
  echo "$total" > "$cursor"
  exit 0
fi

new=$(( total - prev ))
if (( new > max )); then
  start=$(( total - max + 1 ))
  echo "[poll-progress] +${new} 新行；仅显示最近 ${max} 行（跳过 $(( new - max )) 行 — 完整文件: ${file}，从第 $(( prev + 1 )) 行起）"
  sed -n "${start},${total}p" "$file"
else
  sed -n "$(( prev + 1 )),${total}p" "$file"
fi
echo "$total" > "$cursor"
