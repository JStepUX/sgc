#!/usr/bin/env node
// PreToolUse gate. Blocks `git commit` (and only `git commit`) unless a fresh
// .claude/state/pre-commit-qa-passed.json marker exists for the current branch
// and is < 10 minutes old. The marker is written by the pre-commit-qa skill
// at the end of its successful run; it expires by time, not by commit count,
// so a single QA pass covers all commits in the planned batch (e.g. a 4-commit
// fix series) as long as they land within the window. Branch-scoped + time-
// bounded, no per-commit consumption.

import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { resolve } from 'node:path';

const STALE_MS = 10 * 60 * 1000;

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

function allow() {
  process.exit(0);
}

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8') || '{}');
} catch {
  allow();
}

const command = input?.tool_input?.command ?? '';
// Match `git commit` followed by whitespace or end. Excludes `git commit-tree`,
// `git status`, anything embedded in a longer pipeline like `echo git commit`.
if (!/^\s*git\s+commit(\s|$)/.test(command)) {
  allow();
}

let projectRoot;
try {
  projectRoot = execSync('git rev-parse --show-toplevel', { encoding: 'utf8' }).trim();
} catch {
  // Not in a git repo — let `git commit` itself fail naturally.
  allow();
}

const markerPath = resolve(projectRoot, '.claude/state/pre-commit-qa-passed.json');

if (!existsSync(markerPath)) {
  deny('pre-commit-qa has not run on this batch. Run /pre-commit-qa first.');
}

let marker;
try {
  marker = JSON.parse(readFileSync(markerPath, 'utf8'));
} catch {
  deny('pre-commit-qa marker is malformed; re-run /pre-commit-qa.');
}

if (!marker || typeof marker.branch !== 'string' || typeof marker.timestamp !== 'string') {
  deny('pre-commit-qa marker is missing required fields; re-run /pre-commit-qa.');
}

let currentBranch = '';
try {
  currentBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
} catch {
  // unreadable HEAD — let git commit fail naturally
  allow();
}

if (marker.branch !== currentBranch) {
  deny(
    `pre-commit-qa was approved on branch '${marker.branch}' but HEAD is on '${currentBranch}'. ` +
    `Re-run /pre-commit-qa on this branch.`
  );
}

const markerEpoch = Date.parse(marker.timestamp);
if (!Number.isFinite(markerEpoch)) {
  deny('pre-commit-qa marker has an unparseable timestamp; re-run /pre-commit-qa.');
}

const ageMs = Date.now() - markerEpoch;
if (ageMs > STALE_MS || ageMs < 0) {
  const minutes = Math.round(ageMs / 60000);
  deny(`pre-commit-qa marker is stale (${minutes} min old; limit 10). Re-run /pre-commit-qa.`);
}

allow();
