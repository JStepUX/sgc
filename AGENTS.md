The role of this file is to describe common mistakes and confusion points that agents might encounter as they work in this project. If you ever encounter something in the project that surprises you, please alert the developer working with you and indicate that this is the case in this file to help prevent future agents from having the same issue.

## How to add entries

Each entry documents a real gotcha encountered during a session. The format:

```
## <Short, scannable title> (<source task or context>, <date>)

<Two to four sentences describing the surprise, why it happens, and what the
correct behavior looks like. Point at the relevant file paths so the next
agent can verify.>
```

Keep entries tight. If a section would be longer than a screenful, it probably
belongs in a dedicated doc under `docs/` or as a comment at the source. This
file is for **confusion pointers**, not long-form documentation.

Before adding an entry, ask whether the surprise can be invalidated instead of
documented:

- **Push to source.** A pattern with a clear home (a function, a hook) belongs
  in a comment at that site. Agents reading the code find it when they need it.
- **Build a structural check.** Diligence traps ("remember to update X when you
  change Y") should become tests or derived assertions that remove the trap.
  Core Value #3.
- **Write the entry only when neither works** — when the surprise is
  cross-cutting, environmental, or a one-shot heads-up with no natural home.

---

## A just-added manual memory doesn't show in the live thread until reload (brain surgery, 2026-06-01)

Adding a manual ("timeless") memory to the *currently-loaded* chat updates
`chatLog` (the grep corpus) but NOT `messages` (the visible thread) — so the
inserted turn is retrievable immediately but only *appears* in the thread on the
next load of that chat (where it shows as the oldest messages). This is
intentional, not a bug: the editor mutation path (`resyncLiveChatLog` in
`SalienceGatedCognition.tsx`) rebuilds only `chatLog`, deliberately leaving the
ongoing visual conversation untouched so a memory isn't retroactively injected
mid-scroll. SGC keeps `messages` (display) and `chatLog` (retrieval) as separate
state; don't assume mutating one mirrors the other.

## `npm audit` reports a pre-existing "critical" — don't `audit fix --force` it (mermaid add, 2026-06-02)

After `npm install`, `npm audit` shows ~4 moderate + 1 critical. They all live in
the **dev toolchain** (`vitest` → `vite` → `esbuild`, the Vitest-UI advisory
chain), not in any runtime dependency, and they predate recent feature work.
`npm audit fix --force` "resolves" them by bumping `vitest` a major version (a
breaking change) — don't run it. Adding `mermaid` (2026-06-02) pulled ~110
transitive packages but introduced none of these. If a fresh `npm install` shows
the same count, it's this, not something you broke.
