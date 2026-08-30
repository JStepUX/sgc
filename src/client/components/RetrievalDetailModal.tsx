import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import type { GrepDetail, KnowledgeDetail } from '../lib/turn-data';
import { formatRelative } from '../lib/format-time';
import { renderWithHighlights } from '../lib/highlight';

// ============================================================
// RETRIEVAL DETAIL MODAL — the full text behind one citation card.
//
// The rail's grep/knowledge cards are one-line receipts; this modal is the
// receipt opened up: everything the card's fragment ACTUALLY served to Sal
// this turn, verbatim from the persisted diagnostic (turn-data.ts), with the
// terms that tipped the cosine score highlighted (lib/highlight). Read-only
// by design — the memory editor is where text gets changed; this surface
// answers "what did Sal just read, and why did it surface?".
//
// Legacy rows (persisted before the full text was recorded) open to the
// 80-char preview plus a note — degrade, don't hide the affordance.
// ============================================================

/** What the user clicked: an ambient grep hit or a brain fragment. */
export type RetrievalSelection =
  | { kind: 'turn'; detail: GrepDetail }
  | { kind: 'knowledge'; detail: KnowledgeDetail };

interface RetrievalDetailModalProps {
  selection: RetrievalSelection | null;
  onClose: () => void;
}

const RAIL_LABEL = 'font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3';
const META = 'font-mono text-[10.5px] tracking-[0.02em] text-fg-3';
const BLOCK_LABEL = 'font-mono text-[9.5px] uppercase tracking-[0.16em] text-fg-4';
const BODY = 'whitespace-pre-wrap break-words text-[12.5px] leading-[1.6] text-fg-2';

/** One labelled text block (YOU / SAL / the fragment body). */
function ServedBlock({ label, text, stems }: { label: string; text: string; stems: string[] }) {
  return (
    <div>
      <div className={`${BLOCK_LABEL} mb-1`}>{label}</div>
      <div className={BODY}>{renderWithHighlights(text, stems)}</div>
    </div>
  );
}

const LEGACY_NOTE =
  'Full text wasn’t recorded for this turn — it was saved before the inspector kept it. Newer turns open in full.';

export function RetrievalDetailModal({ selection, onClose }: RetrievalDetailModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Escape closes; initial focus lands on the close button; Tab cycles within
  // the dialog (aria-modal promises focus containment — same pattern as
  // DynamicStateModal, even though close is usually the only focusable).
  useEffect(() => {
    if (!selection) return;
    const id = setTimeout(() => closeRef.current?.focus(), 30);
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement as HTMLElement | null;
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => {
      clearTimeout(id);
      document.removeEventListener('keydown', handler);
    };
  }, [selection, onClose]);

  if (!selection) return null;

  const isTurn = selection.kind === 'turn';
  const title = isTurn ? `Turn ${selection.detail.turnIndex}` : selection.detail.brainName;
  const subtitle = isTurn ? null : selection.detail.title;
  const stems = (isTurn && selection.detail.matchedTerms) || [];

  // Meta row is diagnostic chrome, deliberately RICHER than the prompt's
  // prefix: the body text below is the exact serve, but here the date is
  // relative to NOW (the viewer's question is "when was that?"), and
  // `matched` lists the engine's full term report — the highlight set — where
  // Sal's `via "…"` carried only its top 3 (prompt.ts).
  const meta: string[] = [];
  if (isTurn) {
    const g = selection.detail;
    meta.push(`score ${g.score.toFixed(3)}`);
    if (typeof g.conceptScore === 'number' && typeof g.timeScore === 'number') {
      meta.push(`concept ${g.conceptScore.toFixed(3)} × time ${g.timeScore.toFixed(2)}`);
    }
    if (g.timeless) meta.push('timeless');
    else if (typeof g.createdAt === 'number') meta.push(formatRelative(g.createdAt, Date.now()));
    if (stems.length > 0) meta.push(`matched "${stems.join(', ')}"`);
  } else {
    meta.push(`score ${selection.detail.score.toFixed(3)}`);
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ground/70 p-4 backdrop-blur-md"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="retrieval-detail-title"
        className="relative flex max-h-[86vh] w-full max-w-[680px] flex-col overflow-hidden rounded-[22px] border border-hairline-strong bg-ground/85 shadow-glass backdrop-blur-[18px]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 border-b border-hairline px-7 pt-6 pb-5">
          <div className="min-w-0 flex flex-col gap-1.5">
            <span className={RAIL_LABEL}>Served to Sal this turn</span>
            <h2
              id="retrieval-detail-title"
              className="truncate font-serif text-[22px] italic leading-tight text-fg-1"
            >
              {title}
            </h2>
            {subtitle && <div className="truncate text-[12.5px] text-fg-3">{subtitle}</div>}
            <div className={META}>{meta.join(' · ')}</div>
          </div>
          <button
            ref={closeRef}
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-[30px] shrink-0 items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-2 transition-colors hover:border-ember hover:bg-ember hover:text-bone"
          >
            <X className="size-[15px]" />
          </button>
        </div>

        <div className="sal-scroll min-h-0 flex-1 overflow-y-auto px-7 py-5">
          {isTurn ? (
            selection.detail.userContent !== undefined ? (
              <div className="flex flex-col gap-4">
                <ServedBlock label="You" text={selection.detail.userContent} stems={stems} />
                <ServedBlock label="Sal" text={selection.detail.assistContent ?? ''} stems={stems} />
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className={BODY}>{selection.detail.preview}…</div>
                <div className="text-[11px] leading-[1.5] text-fg-4">{LEGACY_NOTE}</div>
              </div>
            )
          ) : selection.detail.text !== undefined ? (
            // No highlight set for brain fragments — DELIBERATE deferral
            // (2026-08-30): the brain vector matches on text + summary +
            // topics + aliases, so a tipping term can be invisible in the
            // fragment text; honest highlighting there needs its own design.
            <ServedBlock label="Fragment" text={selection.detail.text} stems={[]} />
          ) : (
            <div className="flex flex-col gap-3">
              <div className={BODY}>{selection.detail.preview}…</div>
              <div className="text-[11px] leading-[1.5] text-fg-4">{LEGACY_NOTE}</div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
