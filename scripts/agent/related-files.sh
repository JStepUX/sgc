#!/usr/bin/env bash
# related-files.sh — Find all files related to a term/concept.
# Usage: bash scripts/agent/related-files.sh <search-term> [directory]
# Groups results by file, showing match counts and first 3 matching lines.

source "$(dirname "$0")/_common.sh"
cd "$PROJECT_ROOT"

if [ $# -lt 1 ]; then
  err "Usage: related-files.sh <search-term> [directory]"
  exit 1
fi

TERM="$1"
SEARCH_DIR="${2:-.}"

header "Related Files: \"$TERM\""
echo "Scope: $SEARCH_DIR"

matching_files=$(grep -rl "$TERM" "$SEARCH_DIR" "${SOURCE_GLOBS[@]}" $GREP_EXCLUDE 2>/dev/null | head -80 || true)

if [ -z "$matching_files" ]; then
  dim "  No matches found for \"$TERM\" in $SEARCH_DIR"
  exit 0
fi

file_count=$(echo "$matching_files" | wc -l)
echo "Found in $file_count file(s):"
echo ""

while IFS= read -r file; do
  match_count=$(grep -c "$TERM" "$file" 2>/dev/null || true)
  rel_path="${file#./}"
  echo -e "${BOLD}${CYAN}$rel_path${RESET} (${match_count} match(es))"
  grep -n -m 3 "$TERM" "$file" 2>/dev/null | while IFS= read -r match_line; do
    echo "    $match_line"
  done
  echo ""
done <<< "$matching_files"

dim "Search complete: $file_count file(s) matched \"$TERM\""
