import { memo } from 'react';

// ============================================================
// MEMORY PANEL — Constitutional Memories (a read-only preview of the per-chat
// document + an Edit button opening ConstitutionalEditorModal) plus the
// chat's mounted brains. (Brains are the KNOWLEDGE axis — a separate section,
// not a memory tier.)
// ============================================================

/** Slim projection of a mounted pack for this panel's list. */
export interface MountedBrainItem {
  id: string;
  name: string;
  stub: boolean;
  chunkCount: number;
}

interface MemoryPanelProps {
  /** The active chat's constitutional document — freeform prose, rendered
   *  verbatim (trimmed) into the prompt. '' when nothing has been curated. */
  constitutional: string;
  /** Open the ConstitutionalEditorModal. */
  onOpenEditor: () => void;
  // Disabled until the active chat id is ready (pre-hydration / mid chat-swap /
  // hydration failure) — there'd be no chat to scope the edit to.
  editorDisabled: boolean;
  // The live system-prompt version label + a handler to open the editor. Passed
  // as primitives (number + stable callback) rather than a ReactNode so this
  // memoized panel still skips re-renders during streaming / typing.
  promptVersionN: number;
  onOpenPromptEditor: () => void;
  // Disabled until the active chat id is ready (pre-hydration / mid chat-swap /
  // hydration failure) — there'd be no chat to scope the edit to.
  promptEditorDisabled: boolean;
  /** The active chat's mounted brains (mid-chat mount/unmount is deterministic
   * curation, same class as turn gating — spec D6). */
  mountedBrains: MountedBrainItem[];
  /** Open the Brain Manager modal (import/mount/delete lives there now). */
  onOpenBrainManager: () => void;
  /** Disabled while no chat is active (same gating as the prompt editor). */
  brainsDisabled: boolean;
}

const EDIT_BUTTON =
  'shrink-0 whitespace-nowrap rounded-md border border-hairline-strong px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ember transition-colors hover:border-ember/60 hover:bg-ember/[0.08] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline-strong disabled:hover:bg-transparent';

export const MemoryPanel = memo(function MemoryPanel({
  constitutional,
  onOpenEditor,
  editorDisabled,
  promptVersionN,
  onOpenPromptEditor,
  promptEditorDisabled,
  mountedBrains,
  onOpenBrainManager,
  brainsDisabled,
}: MemoryPanelProps) {
  const trimmed = constitutional.trim();

  return (
    <section className="flex flex-col gap-2.5">
      {/* Header: the tier label + its two editors — [ Human ] opens the
          constitutional document (who the user is), [ Agent ] opens the
          system prompt (who Sal is). Two identities, one section; the copy is
          deliberately literal. The short label ("Identity", not the full tier
          name "Constitutional Memories") is what lets all three share a row. */}
      <div className="mb-1 flex items-center justify-between gap-2.5">
        <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3">
          Identity
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={onOpenEditor}
            disabled={editorDisabled}
            aria-label="Edit what Sal knows about you in this chat"
            className={EDIT_BUTTON}
          >
            <span className="text-fg-4">[</span> Human{' '}
            <span className="text-fg-4">]</span>
          </button>
          <button
            type="button"
            onClick={onOpenPromptEditor}
            disabled={promptEditorDisabled}
            aria-label="Edit this chat's system prompt — who Sal is"
            className={EDIT_BUTTON}
          >
            <span className="text-fg-4">[</span> Agent{' '}
            <span className="text-fg-2">v{promptVersionN}</span>{' '}
            <span className="text-fg-4">]</span>
          </button>
        </div>
      </div>

      {/* Read-only preview — editing happens in ConstitutionalEditorModal
          (D2: modal editor, not inline). First ~5 lines via line-clamp; the
          empty state matches prompt.ts's own fallback string so the rail
          never implies more curation than the prompt actually carries. */}
      {trimmed ? (
        <p className="line-clamp-5 whitespace-pre-line text-[13px] leading-[1.55] text-fg-3">
          {constitutional}
        </p>
      ) : (
        <p className="text-[13px] leading-[1.55] text-fg-3">
          (none yet — nothing has been curated for this conversation)
        </p>
      )}

      {/* MOUNTED BRAINS — the knowledge axis. A separate, compact section so
          the two axes read as what they are: memories are about the person,
          brains are reference material about the world. The lifecycle (import
          / mount / delete) now lives in the Brain Manager modal; this strip is
          just a summary + the button that opens it. */}
      <div className="mt-5 mb-1 flex items-center justify-between gap-2.5">
        <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3">
          Mounted Brains
        </span>
        <button
          type="button"
          onClick={onOpenBrainManager}
          disabled={brainsDisabled}
          aria-label="Manage knowledge packs"
          className={EDIT_BUTTON}
        >
          Manage
        </button>
      </div>

      {mountedBrains.length === 0 ? (
        <p className="text-[11.5px] leading-[1.5] text-fg-4">
          No brains mounted — this chat runs on memory alone.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          {mountedBrains.map((b) => (
            <div
              key={b.id}
              className="flex items-baseline justify-between gap-2 px-0.5 py-0.5"
            >
              <span className="overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] text-fg-1">
                {b.name}
              </span>
              <span className="flex shrink-0 items-baseline gap-1.5">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.1em] text-fg-4">
                  {b.chunkCount} chunk{b.chunkCount !== 1 ? 's' : ''}
                </span>
                {b.stub && (
                  <span className="rounded border border-hairline px-1 py-px font-mono text-[8px] uppercase tracking-[0.1em] text-fg-3">
                    stub
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
});
