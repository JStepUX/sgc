#!/usr/bin/env bash
# _common.sh — Shared utilities for SGC agent scripts.
# Source this file: source "$(dirname "$0")/_common.sh"

set -euo pipefail
export MSYS_NO_PATHCONV=1

# ── Project root (two levels up from scripts/agent/) ──
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── Exclude patterns for find/grep ──
EXCLUDE_DIRS="node_modules|\.git|dist|\.vite|build|coverage"
GREP_EXCLUDE="--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist --exclude-dir=.vite --exclude-dir=build --exclude-dir=coverage"

# Source-file extensions SGC cares about. Single source of truth — every
# script greps/finds against this list so adding a file type is a one-liner.
SOURCE_GLOBS=(--include='*.jsx' --include='*.js' --include='*.tsx' --include='*.ts' --include='*.css' --include='*.md')

# ── Colors (disabled when piped) ──
if [ -t 1 ]; then
  BOLD='\033[1m'
  DIM='\033[2m'
  CYAN='\033[36m'
  GREEN='\033[32m'
  YELLOW='\033[33m'
  RED='\033[31m'
  RESET='\033[0m'
else
  BOLD='' DIM='' CYAN='' GREEN='' YELLOW='' RED='' RESET=''
fi

header() {
  echo -e "\n${BOLD}${CYAN}=== $1 ===${RESET}"
}

subheader() {
  echo -e "\n${GREEN}-- $1 --${RESET}"
}

dim() {
  echo -e "${DIM}$1${RESET}"
}

warn() {
  echo -e "${YELLOW}! $1${RESET}" >&2
}

err() {
  echo -e "${RED}x $1${RESET}" >&2
}
