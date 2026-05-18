#!/usr/bin/env bash
# git-context.sh — Pre-commit/PR context bundle.
# Usage: bash scripts/agent/git-context.sh [base-branch]

source "$(dirname "$0")/_common.sh"
cd "$PROJECT_ROOT"

BASE_BRANCH="${1:-main}"

header "Git Status"
git status --short 2>/dev/null || { err "Not a git repo"; exit 1; }

header "Staged Changes"
staged=$(git diff --cached --stat 2>/dev/null)
if [ -n "$staged" ]; then
  echo "$staged"
  subheader "Staged Diff"
  git diff --cached 2>/dev/null | head -200
  if [ "$(git diff --cached 2>/dev/null | wc -l)" -gt 200 ]; then
    dim "  ... (truncated at 200 lines)"
  fi
else
  dim "  (no staged changes)"
fi

header "Unstaged Changes"
unstaged=$(git diff --stat 2>/dev/null)
if [ -n "$unstaged" ]; then
  echo "$unstaged"
  subheader "Unstaged Diff"
  git diff 2>/dev/null | head -200
  if [ "$(git diff 2>/dev/null | wc -l)" -gt 200 ]; then
    dim "  ... (truncated at 200 lines)"
  fi
else
  dim "  (no unstaged changes)"
fi

header "Untracked Files"
untracked=$(git ls-files --others --exclude-standard 2>/dev/null)
if [ -n "$untracked" ]; then
  echo "$untracked" | head -30
  count=$(echo "$untracked" | wc -l)
  [ "$count" -gt 30 ] && dim "  ... and $((count - 30)) more"
else
  dim "  (none)"
fi

header "Recent Commits (last 10)"
git log --oneline -10 2>/dev/null || dim "  (no commits yet)"

header "Current Branch Info"
current=$(git branch --show-current 2>/dev/null)
echo "Branch: ${current:-(none)}"

if git rev-parse --verify "$BASE_BRANCH" &>/dev/null && [ "$current" != "$BASE_BRANCH" ]; then
  ahead=$(git rev-list "$BASE_BRANCH..HEAD" --count 2>/dev/null || echo 0)
  behind=$(git rev-list "HEAD..$BASE_BRANCH" --count 2>/dev/null || echo 0)
  echo "Ahead of $BASE_BRANCH: $ahead commits"
  echo "Behind $BASE_BRANCH: $behind commits"
  if [ "$ahead" -gt 0 ]; then
    subheader "Commits since $BASE_BRANCH"
    git log --oneline "$BASE_BRANCH..HEAD" 2>/dev/null
  fi
fi

header "Commit Message Style (last 5)"
git log --format='  %s' -5 2>/dev/null || dim "  (no commits yet)"
