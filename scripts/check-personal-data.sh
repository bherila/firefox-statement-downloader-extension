#!/usr/bin/env bash
#
# Blocks commits that contain personal data.
#
# This repository's providers are calibrated against real accounts, so real
# account numbers, plan identifiers and employer names are easy to paste into a
# test fixture or a note without noticing. This is a public repository; once
# pushed, rewriting history does not reliably remove them.
#
# Two layers:
#
#   1. A local denylist of literal values, at .git/personal-data-denylist.
#      One extended-regex pattern per line, '#' comments allowed. This file is
#      inside .git and is therefore never committed, which is the point: the
#      literals must not live in the tree they are protecting.
#
#   2. Structural patterns below, which need no local configuration and catch
#      the common shapes regardless of whose machine runs them.
#
# Bypass with `git commit --no-verify` when a match is genuinely a false
# positive; prefer adding an allowance here so the next person is not stuck.
set -uo pipefail

RED=$'\033[31m'; YEL=$'\033[33m'; OFF=$'\033[0m'
DENYLIST="$(git rev-parse --git-dir)/personal-data-denylist"
failed=0

staged_files() {
  git diff --cached --name-only --diff-filter=ACMR
}

# Only added lines matter; removing a secret must never be blocked.
added_lines() {
  git diff --cached -U0 -- "$1" | grep '^+' | grep -v '^+++' || true
}

report() {
  local file="$1" why="$2" line="$3"
  printf '%s  %s%s\n' "$RED" "$file: $why" "$OFF"
  printf '      %s\n' "$(printf '%s' "$line" | cut -c1-110)"
  failed=1
}

for file in $(staged_files); do
  [ -f "$file" ] || continue
  case "$file" in
    *.png|*.jpg|*.gif|*.pdf|*.zip|*.har|pnpm-lock.yaml) continue ;;
    # The checker necessarily contains the shapes it searches for.
    scripts/check-personal-data.sh) continue ;;
  esac

  lines="$(added_lines "$file")"
  [ -z "$lines" ] && continue

  # Layer 1: local literal denylist.
  if [ -f "$DENYLIST" ]; then
    while IFS= read -r pattern; do
      case "$pattern" in ''|'#'*) continue ;; esac
      match="$(printf '%s\n' "$lines" | grep -iE -- "$pattern" | head -1 || true)"
      [ -n "$match" ] && report "$file" "matches denylist pattern /$pattern/" "$match"
    done < "$DENYLIST"
  fi

  # Layer 2: structural patterns.

  # A home directory path identifies the machine's owner and is never needed.
  match="$(printf '%s\n' "$lines" | grep -E '/(Users|home)/[a-z0-9._-]+/' | grep -vE '/(Users|home)/(you|user|example|runner)/' | head -1 || true)"
  [ -n "$match" ] && report "$file" "contains a home directory path" "$match"

  # Account-shaped identifiers next to a field name that implies an account.
  match="$(printf '%s\n' "$lines" \
    | grep -iE '(acct|account|plan|client|household)[a-z]*["'"'"']?\s*[:=]\s*["'"'"']?[A-Z]?[0-9]{7,12}' \
    | grep -vE '[:=]\s*["'"'"']?[A-Z]?(0{4,}|1{4,}|9{4,}|[12]0{5}[0-9]*|1234[0-9]*|5000[0-9]*)' | head -1 || true)"
  [ -n "$match" ] && report "$file" "looks like a real account or plan identifier" "$match"

  # Long digit runs inside a URL path, which is how document links encode ids.
  match="$(printf '%s\n' "$lines" | grep -E 'https?://[^ "'"'"']*/[0-9]{7,}' \
    | grep -vE '/[A-Z]?(0{4,}|1{4,}|9{4,}|[12]0{5}[0-9]*|1234[0-9]*|5000[0-9]*)([/?#]|$)' | head -1 || true)"
  [ -n "$match" ] && report "$file" "URL contains a long numeric identifier" "$match"

  # Session material: anything that would authenticate as the user.
  match="$(printf '%s\n' "$lines" \
    | grep -iE '(cookie|set-cookie|bearer|authorization|txntoken|session[_-]?id)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?(Bearer[[:space:]]+)?[A-Za-z0-9._%+/-]{16,}' \
    | head -1 || true)"
  [ -n "$match" ] && report "$file" "looks like session or auth material" "$match"
done

if [ "$failed" -ne 0 ]; then
  cat <<EOF

${YEL}Commit blocked: possible personal data.${OFF}

  Replace real values with synthetic ones. Account-shaped fixtures should use
  obviously-fake values such as 100000001 or 2000001.

  If this is genuinely a false positive:
      git commit --no-verify
  and consider adding an allowance in scripts/check-personal-data.sh.

  To match literal values on this machine, add extended-regex patterns to:
      .git/personal-data-denylist
  which is inside .git and is never committed.

EOF
  exit 1
fi
exit 0
