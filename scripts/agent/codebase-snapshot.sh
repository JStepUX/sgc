#!/usr/bin/env bash
# codebase-snapshot.sh — Project orientation in one call.
# Usage: bash scripts/agent/codebase-snapshot.sh

source "$(dirname "$0")/_common.sh"
cd "$PROJECT_ROOT"

header "Project Structure"
# Tree view excluding noise directories, max depth 4.
find . -maxdepth 4 \
  -not -path '*/node_modules/*' \
  -not -path '*/.git/*' \
  -not -path '*/.git' \
  -not -path '*/dist/*' \
  -not -path '*/.claude/state/*' \
  -not -name '*.lock' \
  -not -name 'package-lock.json' \
  \( -type f -o -type d \) | sort | head -120

header "File Counts by Type"
for ext in jsx js tsx ts css md; do
  count=$(find . -name "*.${ext}" 2>/dev/null | grep -vE "$EXCLUDE_DIRS" | wc -l)
  printf "  %-6s %d\n" ".${ext}" "$count"
done

header "Recent Git History (last 15 commits)"
git log --oneline -15 2>/dev/null || dim "  (no commits yet)"

header "Package Scripts"
if [ -f "package.json" ]; then
  node --input-type=module <<'EOF' 2>/dev/null || dim "  (could not parse package.json)"
import { readFileSync } from 'fs';
const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
if (pkg.scripts && Object.keys(pkg.scripts).length) {
  Object.entries(pkg.scripts).forEach(([k, v]) => console.log('  ' + k + ': ' + v));
} else {
  console.log('  (no scripts defined)');
}
EOF
else
  dim "  (no package.json — SGC has no build tooling yet; see CLAUDE.md)"
fi

header "Key Files"
for f in sgc-phase-1-5.jsx package.json vite.config.js vite.config.ts index.html CLAUDE.md AGENTS.md README.md; do
  [ -f "$f" ] && echo "  + $f"
done

header "Claude Code Surface"
[ -d ".claude/agents" ]  && printf "  agents:  %d\n" "$(find .claude/agents -name '*.md' 2>/dev/null | wc -l)"
[ -d ".claude/skills" ]  && printf "  skills:  %d\n" "$(find .claude/skills -name 'SKILL.md' 2>/dev/null | wc -l)"
[ -d ".claude/hooks" ]   && printf "  hooks:   %d\n" "$(find .claude/hooks -type f 2>/dev/null | wc -l)"
[ -d "scripts/agent" ]   && printf "  scripts: %d\n" "$(find scripts/agent -name '*.sh' 2>/dev/null | wc -l)"

echo ""
dim "Snapshot generated from $PROJECT_ROOT"
