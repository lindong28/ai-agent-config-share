#!/usr/bin/env bash
set -euo pipefail

helper_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
helper="${helper_dir}/poll-progress.sh"
tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/poll-progress-test.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local got="$1"
  local want="$2"
  local label="$3"
  [[ "$got" == "$want" ]] || fail "${label}: expected [$want], got [$got]"
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" == *"$needle"* ]] || fail "${label}: missing [$needle] in [$haystack]"
}

assert_not_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"
  [[ "$haystack" != *"$needle"* ]] || fail "${label}: unexpectedly found [$needle] in [$haystack]"
}

write_lines() {
  local file="$1"
  local start="$2"
  local end="$3"
  local prefix="${4:-line}"
  local i="$start"
  while (( i <= end )); do
    printf '%s-%03d\n' "$prefix" "$i" >> "$file"
    i=$(( i + 1 ))
  done
}

run_helper() {
  local stdout="$tmpdir/stdout"
  local stderr="$tmpdir/stderr"
  local rc
  set +e
  bash "$helper" "$@" > "$stdout" 2> "$stderr"
  rc=$?
  set -e
  RUN_RC="$rc"
  RUN_OUT="$(cat "$stdout")"
  RUN_ERR="$(cat "$stderr")"
}

# IV5 / V7: missing file exits 0, writes waiting only to stderr.
missing="$tmpdir/missing.output"
run_helper "$missing"
assert_eq "$RUN_RC" "0" "missing file rc"
assert_eq "$RUN_OUT" "" "missing file stdout"
assert_contains "$RUN_ERR" "[poll-progress] waiting: ${missing} 尚未创建" "missing file stderr"
echo "ok IV5/V7 missing file waits on stderr with exit 0"

# IV1, IV4, V1, V2, V4, V6: exact incremental windows, persisted cursor,
# independent process calls, no-new prompt, and short first read equals full file.
inc="$tmpdir/incremental.output"
write_lines "$inc" 1 5
run_helper "$inc"
assert_eq "$RUN_RC" "0" "first incremental rc"
assert_eq "$RUN_OUT" $'line-001\nline-002\nline-003\nline-004\nline-005' "first read full short output"
assert_eq "$(cat "${inc}.progress-cursor")" "5" "cursor after first read"

write_lines "$inc" 6 8
run_helper "$inc"
assert_eq "$RUN_OUT" $'line-006\nline-007\nline-008' "second read only appended lines"
assert_not_contains "$RUN_OUT" "line-001" "second read excludes old line"
assert_eq "$(cat "${inc}.progress-cursor")" "8" "cursor after second read"

run_helper "$inc"
assert_contains "$RUN_OUT" "[poll-progress] 无新增（共 8 行）" "no-new prompt"
assert_not_contains "$RUN_OUT" "line-008" "no-new excludes file content"
assert_eq "$(cat "${inc}.progress-cursor")" "8" "cursor after no-new read"

rm "${inc}.progress-cursor"
run_helper "$inc" 20
assert_eq "$RUN_OUT" $'line-001\nline-002\nline-003\nline-004\nline-005\nline-006\nline-007\nline-008' "deleted cursor resets to full read"
assert_eq "$(cat "${inc}.progress-cursor")" "8" "cursor after reset read"
echo "ok IV1/IV4/V1/V2/V4/V6 incremental windows, no-new state, persisted cursor, reset, short full read"

# IV2 / V3: burst truncation returns annotation plus exactly the last max lines.
burst="$tmpdir/burst.output"
write_lines "$burst" 1 5 "burst"
run_helper "$burst" 80 >/dev/null
write_lines "$burst" 6 505 "burst"
run_helper "$burst"
assert_contains "$RUN_OUT" "[poll-progress] +500 新行；仅显示最近 80 行（跳过 420 行" "burst annotation skipped count"
assert_contains "$RUN_OUT" "完整文件: ${burst}" "burst annotation full path"
assert_contains "$RUN_OUT" "从第 6 行起" "burst annotation original start"
assert_eq "$(printf '%s\n' "$RUN_OUT" | wc -l | tr -d ' ')" "81" "burst output line count"
assert_contains "$RUN_OUT" "burst-426" "burst includes first retained line"
assert_contains "$RUN_OUT" "burst-505" "burst includes last retained line"
assert_not_contains "$RUN_OUT" "burst-425" "burst excludes skipped line"
assert_eq "$(cat "${burst}.progress-cursor")" "505" "cursor after burst read"
echo "ok IV2/V3 burst truncates to max lines with explicit skipped-count annotation"

# IV3: no-new branch also self-heals when the file unexpectedly shrinks.
shrink="$tmpdir/shrink.output"
write_lines "$shrink" 1 4 "shrink"
run_helper "$shrink"
sed -n '1,2p' "$shrink" > "$tmpdir/shrink.short"
mv "$tmpdir/shrink.short" "$shrink"
run_helper "$shrink"
assert_contains "$RUN_OUT" "[poll-progress] 无新增（共 2 行）" "shrink no-new prompt"
assert_not_contains "$RUN_OUT" "shrink-001" "shrink no content"
assert_eq "$(cat "${shrink}.progress-cursor")" "2" "cursor self-heals to shrunken total"
write_lines "$shrink" 3 3 "shrink"
run_helper "$shrink"
assert_eq "$RUN_OUT" "shrink-003" "post-shrink append resumes from healed cursor"
assert_eq "$(cat "${shrink}.progress-cursor")" "3" "cursor after post-shrink append"
echo "ok IV3 total<=prev no-new branch self-heals shrunken files"

# IV6 / V5: helper never mutates source file; full record stays readable.
readonly_file="$tmpdir/readonly.output"
write_lines "$readonly_file" 1 12 "full"
before_cksum="$(cksum "$readonly_file")"
before_bytes="$(wc -c < "$readonly_file" | tr -d ' ')"
run_helper "$readonly_file" 5
after_cksum="$(cksum "$readonly_file")"
after_bytes="$(wc -c < "$readonly_file" | tr -d ' ')"
assert_eq "$after_cksum" "$before_cksum" "source cksum unchanged"
assert_eq "$after_bytes" "$before_bytes" "source byte count unchanged"
assert_eq "$(wc -l < "$readonly_file" | tr -d ' ')" "12" "full source line count preserved"
echo "ok IV6/V5 helper does not mutate source file; full record remains complete"

echo "poll-progress tests passed"
