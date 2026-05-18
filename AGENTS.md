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

## `callClaude` sends no auth or version headers (project bootstrap, 2026-05-18)

`callClaude` in `sgc-phase-1-5.jsx` (~line 197) POSTs to
`https://api.anthropic.com/v1/messages` with only a `Content-Type` header — no
`x-api-key`, no `anthropic-version`, no `anthropic-dangerous-direct-browser-access`.
As written, that request only works behind something that injects auth (a proxy,
or the Claude artifact runtime). A plain Vite/CRA build will get a 401 / CORS
failure. This is expected for a Phase 1.5 prototype — but if you stand up real
build tooling, routing the call through a keyed backend proxy is a prerequisite,
not an afterthought. **Never hardcode an `sk-ant-...` key into the component**
to "make it work" — `scripts/agent/health-check.sh` scans for exactly that.

## No build tooling — `npm`/`vite`/`vitest` are not wired (project bootstrap, 2026-05-18)

SGC has no `package.json`, bundler, or test harness yet. `sgc-phase-1-5.jsx` is a
standalone reference artifact. Don't assume `npm test` or `npm run dev` exist;
`scripts/agent/health-check.sh` is written to degrade gracefully and report this
rather than fail. If a task needs a harness, flag it — standing one up is a
deliberate future-phase decision, not a silent prerequisite.
