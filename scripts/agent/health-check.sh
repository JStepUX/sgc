#!/usr/bin/env bash
# health-check.sh — Repo health: build tooling, tests, git state, code markers.
# Usage: bash scripts/agent/health-check.sh
#
# SGC has no build tooling yet (see CLAUDE.md). This script is adaptive: it runs
# whatever the project actually has and reports honestly on what it lacks.

source "$(dirname "$0")/_common.sh"
cd "$PROJECT_ROOT"

header "Health Check"

# ── Build tooling ──
subheader "Build Tooling"
if [ -f "package.json" ]; then
  echo -e "  ${GREEN}+ package.json present${RESET}"
  has_script() { node -e "process.exit(require('./package.json').scripts?.['$1']?0:1)" 2>/dev/null; }

  if has_script "lint"; then
    set +e; lint_out=$(npm run --silent lint 2>&1); lint_exit=$?; set -e
    echo "$lint_out" | tail -20
    [ "$lint_exit" = "0" ] && echo -e "  ${GREEN}+ lint passed${RESET}" || echo -e "  ${RED}x lint failed (exit $lint_exit)${RESET}"
  else
    dim "  (no 'lint' script)"
  fi

  if has_script "test"; then
    set +e; test_out=$(npm test --silent 2>&1); test_exit=$?; set -e
    echo "$test_out" | tail -30
    if [ "$test_exit" = "0" ]; then
      echo -e "  ${GREEN}+ tests passed${RESET}"
    elif echo "$test_out" | grep -qE '@rollup/rollup-|@esbuild/|Cannot find (native )?module'; then
      # node_modules holds platform-native binaries (Rollup, esbuild). A tree
      # installed by one OS/shell will not load under another — that is an
      # environment mismatch, NOT a real test failure. Don't cry wolf.
      warn "tests could not run: a platform-native module (Rollup/esbuild) failed to load."
      warn "node_modules was installed for a different OS/shell than this one."
      warn "Fix: run 'npm install' in THIS shell (project standard: git-bash on Windows),"
      warn "or run tests from the shell where node_modules was installed. See AGENTS.md."
    else
      echo -e "  ${RED}x tests failed (exit $test_exit)${RESET}"
    fi
  else
    dim "  (no 'test' script — no test harness wired yet)"
  fi
else
  warn "No package.json. SGC currently ships as a standalone .jsx artifact;"
  warn "there is no lint/test/build pipeline to run. See CLAUDE.md."
fi

# ── Git Status ──
subheader "Git Status"
git status --short 2>/dev/null || dim "  (not a git repo)"

# ── Code Markers ──
subheader "Code Markers (TODO / FIXME / HACK / XXX)"
for marker in TODO FIXME HACK XXX; do
  count=$(grep -rE "\b${marker}\b" . "${SOURCE_GLOBS[@]}" $GREP_EXCLUDE 2>/dev/null | wc -l || true)
  printf "  %-8s %d\n" "$marker" "${count:-0}"
done

# ── Secret-leak sanity check ──
subheader "Secret Sanity Check"
leaks=$(grep -rEn "sk-ant-[A-Za-z0-9]" . "${SOURCE_GLOBS[@]}" $GREP_EXCLUDE 2>/dev/null || true)
if [ -n "$leaks" ]; then
  echo -e "  ${RED}x Possible API key literal(s) found:${RESET}"
  echo "$leaks" | head -10 | sed 's/^/    /'
else
  echo -e "  ${GREEN}+ no Anthropic key literals in source${RESET}"
fi

echo ""
dim "Health check complete"
