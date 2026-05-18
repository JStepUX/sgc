---
name: bash-tools
description: >
  Lists the agent bash utility scripts in scripts/agent/ with their headers and
  usage lines. Use this at the start of a session, when decomposing a new task,
  or whenever you catch yourself about to reach for raw tool calls that one of
  these scripts already composes. Refreshes your working memory of the bash
  layer so you don't reinvent what's already there.
---

# Agent Bash Tools — Live Index

The `scripts/agent/` folder contains bash utilities that collapse common
multi-tool-call patterns into single invocations. They produce deterministic
output and are the preferred entry point for discovery, verification, and
context-gathering. Reaching for raw Grep/Read/Glob when one of these already
exists wastes context and misses the stable format.

## Step 1: List the current tools

Run this exact command and display the output:

```bash
for f in scripts/agent/*.sh; do
  name=$(basename "$f")
  [[ "$name" == "_common.sh" ]] && continue
  desc=$(sed -n '2p' "$f" | sed -E 's/^# *//')
  usage=$(sed -n '3p' "$f" | sed -E 's/^# *//')
  printf '%s\n  %s\n  %s\n\n' "$name" "$desc" "$usage"
done
```

This reads line 2 (description) and line 3 (usage) of each script, which is the
canonical header format in this folder. If a script is missing that header, the
output is blank for it — flag it so the header can be added.

## Step 2: Match to the current task

After listing, identify in one or two sentences which scripts apply to what
you're about to do, and reach for them *first*. Examples:

- "I need to get oriented in the repo" → `codebase-snapshot.sh`
- "I'm about to commit or open a PR" → `git-context.sh` then `health-check.sh`
- "I'm hunting for where a concept lives" → `related-files.sh`

If none apply, proceed with raw tool calls and note why none fit — that gap is
data for whether a new script earns its spot later.

## Step 3: Note anything surprising

If a script has appeared or disappeared since you last saw the list, mention it
to the user. The folder is the source of truth, not anyone's memory of it.
