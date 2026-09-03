import { memo, useEffect, useState } from 'react';
import type { DynamicState } from '../lib/types';
import type { TurnData } from '../lib/turn-data';
import { operatorLabel } from '../lib/spontaneity/flexDeck';
import { pacingOutcomeLabel } from '../lib/pacing';
import { DEFAULT_SLACK_THRESHOLD } from '../lib/spontaneity/slackDetector';
import { RAIL_LABEL, RAIL_SUB } from './rail-styles';
import { RetrievalDetailModal, type RetrievalSelection } from './RetrievalDetailModal';
import { Card } from '@/components/ui/card';

// ============================================================
// TURN INSPECTOR — Architecture Trace, status, citations, deltas.
// ============================================================

/** The state fields in render order, with the labels the rail shows. Matches
 *  flattenStateForPrompt's labelling so the card and the prompt agree. */
const STATE_ROWS: { key: keyof DynamicState; label: string }[] = [
  { key: 'goal', label: 'goal' },
  { key: 'appraisal', label: 'feeling' },
  { key: 'association', label: 'association' },
  { key: 'passing_thought', label: 'passing thought' },
  { key: 'noticed', label: 'noticed' },
  { key: 'unexpressed_impulse', label: 'impulse' },
];

const STATE_EDIT_BUTTON =
  'shrink-0 whitespace-nowrap rounded-md border border-hairline-strong px-2 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-ember transition-colors hover:border-ember/60 hover:bg-ember/[0.08] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline-strong disabled:hover:bg-transparent';

interface TurnInspectorProps {
  turnData: TurnData | null;
  /** A post-reply state turn is running for this turn (the "reflecting…" line). */
  stateInFlight?: boolean;
  /** Open the DynamicStateModal. */
  onOpenStateEditor?: () => void;
  /** No persisted turn to write a state to yet. */
  stateEditorDisabled?: boolean;
  /** The newest state anywhere in the log, shown (marked as carried) when THIS
   *  turn has none — that is the state the next prompt will actually read
   *  (D13), and hiding it would misreport a failed state call as a blank
   *  inner life. */
  carriedState?: DynamicState | null;
}

export const TurnInspector = memo(function TurnInspector({
  turnData,
  stateInFlight = false,
  onOpenStateEditor,
  stateEditorDisabled = false,
  carriedState = null,
}: TurnInspectorProps) {
  // Which citation card is opened in the RetrievalDetailModal. Local by
  // design: the selection is derived purely from this turn's props. The modal
  // itself portals to document.body, so the rail's overflow doesn't clip it.
  const [selection, setSelection] = useState<RetrievalSelection | null>(null);

  // This component stays MOUNTED across turns (memo, not keyed), so useState
  // survives the next turn's diagnostics replacing the rail — an open receipt
  // must be closed explicitly or the modal outlives the turn it belongs to.
  useEffect(() => {
    setSelection(null);
  }, [turnData?.turnNumber]);

  if (!turnData) {
    return <div className="py-2 text-[12.5px] italic text-fg-3">Nothing yet. Say something.</div>;
  }

  // The Dynamic State card holds BOTH outputs of the state turn — and it is
  // the recurrence's CONTROL surface, so it also renders whenever the editor
  // is usable: a turn whose state call failed is exactly the turn that needs
  // the [ Edit ] button still on screen.
  const state = turnData.dynamicState ?? null;
  const summary = turnData.summary ?? null;
  const hasSummary =
    summary !== null &&
    (summary.persistent.length > 0 ||
      summary.volatile.length > 0 ||
      summary.established_patterns.length > 0);
  // No state of its own → show the one being carried forward instead (D13).
  const effectiveState = state ?? carriedState ?? null;
  const stateIsCarried = !state && carriedState !== null;
  const canEditState = !stateEditorDisabled && !!onOpenStateEditor;
  const stateRows = effectiveState
    ? STATE_ROWS.map(({ key, label }) => {
        const v = effectiveState[key];
        const text = Array.isArray(v) ? v.filter((s) => s.trim()).join('; ') : (v ?? '').trim();
        return text ? { label, text } : null;
      }).filter((r): r is { label: string; text: string } => r !== null)
    : [];

  // apiCalls counts EVERY call the turn made (D12), state turn included — but
  // "paused to remember" is a recall fact, and the reply's own call count is
  // what the savings tile compares. Subtract the state call where it landed
  // (stateTokens present ⇔ it was counted) so neither display misreports an
  // ordinary base turn as a recall turn.
  const replyApiCalls = Math.max(1, (turnData.apiCalls ?? 1) - (turnData.stateTokens ? 1 : 0));
  const recalled = (turnData.recalls?.length ?? 0) > 0;

  const metrics = [
    { value: turnData.inputTokens.toLocaleString(), label: 'Input tk' },
    { value: turnData.outputTokens.toLocaleString(), label: 'Output tk' },
    { value: `${(turnData.totalLatency / 1000).toFixed(1)}s`, label: 'Latency' },
  ];

  return (
    <section className="flex flex-col gap-2.5">
      <div className={RAIL_LABEL}>Turn {turnData.turnNumber} Diagnostics</div>

      <div className={RAIL_SUB}>Architecture Trace</div>
      <div className="grid grid-cols-3 gap-2">
        {metrics.map((m) => (
          <Card key={m.label} className="gap-0 rounded-xl border px-2 py-3 text-center shadow-none">
            <div className="font-mono text-lg font-medium tracking-[-0.01em] text-ember">{m.value}</div>
            <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-fg-3">{m.label}</div>
          </Card>
        ))}
      </div>

      <ul className="mt-2 mb-1 flex list-none flex-col gap-1.5 p-0">
        <li className="flex items-center gap-2 font-mono text-[11px] tracking-[0.02em] text-fg-2">
          <span className="size-[5px] shrink-0 rounded-full bg-ember" />
          Local buffer: {turnData.localBufferSize > 0 ? `${turnData.localBufferSize} msgs` : 'empty (turn 1)'}
        </li>
        <li className="flex items-center gap-2 font-mono text-[11px] tracking-[0.02em] text-fg-2">
          <span className="size-[5px] shrink-0 rounded-full bg-ember" />
          Cosine Grep: {turnData.grepFired
            ? `${turnData.grepMatches} match${turnData.grepMatches !== 1 ? 'es' : ''}`
            : 'no matches above threshold'}
        </li>
        {turnData.knowledgeDetails && turnData.knowledgeDetails.length > 0 && (
          // The knowledge axis (mounted brains). Line renders only when
          // fragments actually retrieved — old turns predate the field, and
          // a mounted-but-unmatched turn carries null (the digest still went
          // to the prompt; that's a prompt fact, not a retrieval event).
          <li className="flex items-center gap-2 font-mono text-[11px] tracking-[0.02em] text-fg-2">
            <span className="size-[5px] shrink-0 rounded-full bg-ember" />
            Knowledge: {turnData.knowledgeDetails.length} fragment{turnData.knowledgeDetails.length !== 1 ? 's' : ''}
          </li>
        )}
        {turnData.recalls && turnData.recalls.length > 0 && (
          // Deliberate recall — Sal paused mid-turn and queried its own
          // history through the same deterministic engine. Per-event cards
          // below carry the query/neighbor target + match counts.
          <li className="flex items-center gap-2 font-mono text-[11px] tracking-[0.02em] text-fg-2">
            <span className="size-[5px] shrink-0 rounded-full bg-ember" />
            Deliberate recall: {turnData.recalls.length} recall{turnData.recalls.length !== 1 ? 's' : ''}
            {typeof turnData.apiCalls === 'number' ? ` (${replyApiCalls} reply calls)` : ''}
          </li>
        )}
        {typeof turnData.spontaneitySimilarity === 'number' && (
          // Always-on slack reading — the calibration signal. Shown even when
          // nothing fired so the firing line (DEFAULT_SLACK_THRESHOLD) can be
          // tuned against how close real conversations actually get.
          <li className="flex items-center gap-2 font-mono text-[11px] tracking-[0.02em] text-fg-2">
            <span className="size-[5px] shrink-0 rounded-full bg-ember" />
            Spontaneity: {turnData.spontaneityFired ? 'fired' : 'dormant'} — slack{' '}
            {turnData.spontaneitySimilarity.toFixed(2)} / fire ≥ {DEFAULT_SLACK_THRESHOLD.toFixed(2)}
          </li>
        )}
      </ul>

      {turnData.grepFired && turnData.grepDetails && (
        <div className="mt-1 flex flex-col gap-2">
          {turnData.grepDetails.map((g, i) => (
            // The card is a receipt; clicking opens the RetrievalDetailModal
            // with the full served text. <button> for keyboard/SR access.
            <Card
              key={i}
              className="gap-0 rounded-[4px_10px_10px_4px] border border-l-2 border-l-ember px-0 py-0 shadow-none"
            >
              <button
                type="button"
                onClick={() => setSelection({ kind: 'turn', detail: g })}
                aria-haspopup="dialog"
                aria-label={`Open the full text retrieved from turn ${g.turnIndex}`}
                className="w-full cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-ember/[0.05]"
              >
                <div className="mb-1 flex items-baseline gap-3 font-mono text-[10.5px] text-fg-3">
                  <span className="font-medium text-fg-1">Turn {g.turnIndex}</span>
                  <span>score: {g.score.toFixed(3)}</span>
                  <span className="ml-auto shrink-0 text-fg-4">expand ›</span>
                </div>
                <div className="overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-[1.5] text-fg-2">
                  {g.preview}
                </div>
              </button>
            </Card>
          ))}
        </div>
      )}

      {turnData.knowledgeDetails && turnData.knowledgeDetails.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          {turnData.knowledgeDetails.map((k, i) => (
            // Same card idiom as a grep match — provenance line (brain ·
            // document · score), then the fragment preview. Clickable like
            // the grep cards; opens the same modal.
            <Card
              key={i}
              className="gap-0 rounded-[4px_10px_10px_4px] border border-l-2 border-l-ember px-0 py-0 shadow-none"
            >
              <button
                type="button"
                onClick={() => setSelection({ kind: 'knowledge', detail: k })}
                aria-haspopup="dialog"
                aria-label={`Open the full fragment retrieved from ${k.brainName}`}
                className="w-full cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-ember/[0.05]"
              >
                <div className="mb-1 flex items-baseline gap-3 font-mono text-[10.5px] text-fg-3">
                  <span className="font-medium text-fg-1">{k.brainName}</span>
                  <span className="overflow-hidden text-ellipsis whitespace-nowrap">{k.title}</span>
                  <span className="shrink-0">score: {k.score.toFixed(3)}</span>
                  <span className="shrink-0 text-fg-4">›</span>
                </div>
                <div className="overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-[1.5] text-fg-2">
                  {k.preview}
                </div>
              </button>
            </Card>
          ))}
        </div>
      )}

      {turnData.recalls && turnData.recalls.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          {turnData.recalls.map((r, i) => (
            // Same card idiom as a grep match — round + mode line, then what
            // Sal actually asked for. The inspector is the technical surface,
            // so query text renders verbatim here.
            <Card
              key={i}
              className="gap-0 rounded-[4px_10px_10px_4px] border border-l-2 border-l-ember px-3 py-2.5 shadow-none"
            >
              <div className="mb-1 flex items-baseline gap-3 font-mono text-[10.5px] text-fg-3">
                <span className="font-medium text-fg-1">Deliberate recall · round {r.round}</span>
                <span>
                  {r.matches} match{r.matches !== 1 ? 'es' : ''}
                </span>
              </div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-[1.5] text-fg-2">
                {typeof r.input.query === 'string' && r.input.query.trim()
                  ? `query: “${r.input.query}”`
                  : typeof r.input.around_turn === 'number'
                    ? `around turn ${r.input.around_turn}`
                    : 'empty recall input'}
              </div>
            </Card>
          ))}
        </div>
      )}

      {turnData.spontaneityFired && turnData.spontaneityDirective && (
        // The exact directive injected into Sal's prompt this turn — the INPUT
        // half of transparency. Whether Sal acted on it is a read of the reply
        // (we can't auto-grade that without a model in the loop). Same card idiom
        // as a grep match.
        <Card className="gap-0 rounded-[4px_10px_10px_4px] border border-l-2 border-l-ember px-3 py-2.5 shadow-none">
          <div className="mb-1 flex items-baseline gap-2 font-mono text-[10.5px] text-fg-3">
            <span className="font-medium text-fg-1">⟐ {operatorLabel(turnData.spontaneityDirective)}</span>
            <span>injected this turn</span>
          </div>
          <div className="text-xs leading-[1.5] text-fg-2">
            {turnData.spontaneityDirective}
          </div>
        </Card>
      )}

      {typeof turnData.pacingCeiling === 'number' && (
        // Reply pacing (lib/pacing.ts): the paragraph ceiling this reply was
        // drawn — visible AFTER the fact, never before (the draw is meant to be
        // unpredictable at the composer) — and how the reply actually ended
        // against it. "cut at the ceiling" is the server counter firing; the
        // token-cap readings are the hard-cap fallback. Pre-pacing rows carry
        // no ceiling and render nothing here.
        <Card className="gap-0 rounded-[4px_10px_10px_4px] border border-l-2 border-l-fg-3 px-3 py-2.5 shadow-none">
          <div className="flex items-baseline gap-2 font-mono text-[10.5px] text-fg-3">
            <span className="font-medium text-fg-1">
              ¶ ceiling {turnData.pacingCeiling} paragraph{turnData.pacingCeiling === 1 ? '' : 's'}
            </span>
            <span>{pacingOutcomeLabel(turnData)}</span>
          </div>
        </Card>
      )}

      {(() => {
        // Context-savings card — the thesis of Phase 1.5 made legible.
        //
        // Left: what we actually sent (real `usage.input_tokens` from the API —
        // or a flagged client-side estimate when the server couldn't know it:
        // a paragraph-cut reply, or a local server that omits usage).
        // Right: what a naive "send the whole history every turn" pipeline
        // would have sent (estimated client-side, see lib/tokens.ts). The
        // ratio is the savings SGC's tiered curation buys.
        //
        // `naiveTokens` is optional — turns persisted before this field
        // existed don't carry it. Fall back to a quieter, single-number
        // variant in that case so old chat replays still render cleanly.
        const sent = turnData.inputTokens;
        const naive = turnData.naiveTokens ?? 0;
        const hasNaive = naive > 0;
        // The tile compares MEMORY CURATION, so it speaks in reply calls only
        // (replyApiCalls — the state call is excluded here and accounted on
        // the Dynamic State card, D12). Recall turns bill each round's input,
        // so Sent reads visibly larger on them — expected, and worth saying
        // rather than leaving the number odd.
        const callsLine = recalled
          ? `${replyApiCalls} API calls for the reply — Sal paused to remember (reply tokens are summed across rounds).`
          : `${replyApiCalls} API call${replyApiCalls !== 1 ? 's' : ''} for the reply.`;
        const savedPct = hasNaive && naive > sent
          ? Math.round(((naive - sent) / naive) * 100)
          : 0;
        return (
          <Card className="gap-0 rounded-xl border px-[14px] py-3 shadow-none">
            <div className={RAIL_SUB}>Context Savings</div>
            {hasNaive ? (
              <>
                <div className="mt-1.5 grid grid-cols-2 gap-2">
                  <div>
                    <div className="font-mono text-[18px] font-semibold leading-none text-ember">
                      {sent.toLocaleString()}
                    </div>
                    <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-fg-3">
                      Sent{turnData.usageEstimated ? ' (est.)' : ''}
                    </div>
                  </div>
                  <div>
                    <div className="font-mono text-[18px] font-medium leading-none text-fg-2">
                      ~{naive.toLocaleString()}
                    </div>
                    <div className="mt-1 font-mono text-[9.5px] uppercase tracking-[0.16em] text-fg-3">
                      Naive
                    </div>
                  </div>
                </div>
                {savedPct > 0 && (
                  <div className="mt-2.5 flex items-baseline gap-2 border-t border-hairline pt-2">
                    <span className="font-mono text-[15px] font-medium text-success">
                      −{savedPct}%
                    </span>
                    <span className="text-[10.5px] text-fg-3">
                      vs naive “send everything” baseline
                    </span>
                  </div>
                )}
                <div className="mt-1.5 text-[10.5px] leading-[1.4] text-fg-3">
                  Naive is an estimate (~4 chars / token). {callsLine}
                </div>
              </>
            ) : (
              <>
                <div className="mt-1.5 font-mono text-[22px] font-semibold text-ember">{replyApiCalls}</div>
                <div className="mt-0.5 text-[10.5px] text-fg-3">
                  {recalled ? 'Sal paused to remember. Retrieval is still TF-IDF (0 ms).' : 'Sal only. Grep is TF-IDF (0 ms).'}
                </div>
              </>
            )}
          </Card>
        );
      })()}

      {(state || hasSummary || stateInFlight || canEditState) && (
        // DYNAMIC STATE — both outputs of the post-reply state turn in one
        // card: Sal's inner state (which the NEXT prompt reads) above, this
        // turn's observation below. The state is editable because the
        // recurrence is only safe while it stays a control surface, not just a
        // display one. Diegetic copy — "state turn" never reaches the user.
        <Card className="gap-0 rounded-xl border px-[14px] py-3 shadow-none">
          <div className="flex items-center justify-between gap-2">
            <div className={RAIL_SUB}>Dynamic State</div>
            <button
              type="button"
              onClick={onOpenStateEditor}
              disabled={stateEditorDisabled || !onOpenStateEditor}
              aria-label="Edit Sal's inner state for this turn"
              className={STATE_EDIT_BUTTON}
            >
              <span className="text-fg-4">[</span> Edit <span className="text-fg-4">]</span>
            </button>
          </div>

          {stateInFlight && (
            <div className="mt-2 animate-pulse font-mono text-[10.5px] tracking-wide text-fg-3">
              reflecting…
            </div>
          )}

          {stateRows.length > 0 ? (
            <>
              {stateIsCarried && (
                // The next prompt still reads this older state — say so rather
                // than showing a blank that isn't what Sal will feel.
                <div className="mt-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg-4">
                  carried from an earlier turn
                </div>
              )}
              <div className={`mt-2 flex flex-col gap-1${stateIsCarried ? ' opacity-60' : ''}`}>
                {stateRows.map((r) => (
                  <div key={r.label} className="flex gap-2">
                    <span className="w-[68px] shrink-0 pt-px font-mono text-[9.5px] uppercase leading-[1.5] tracking-[0.12em] text-fg-4">
                      {r.label}
                    </span>
                    <span className="min-w-0 text-[11px] leading-[1.45] text-fg-2">{r.text}</span>
                  </div>
                ))}
              </div>
            </>
          ) : (
            !stateInFlight && (
              <div className="mt-2 text-[11px] leading-[1.4] text-fg-4">
                {canEditState
                  ? '(no state yet — it forms after a reply, or write one with Edit)'
                  : '(no state yet — forms after the next turn)'}
              </div>
            )
          )}

          {hasSummary && summary && (
            <div className="mt-3 border-t border-hairline pt-2">
              {/* The structured view of this turn's summary. The inspector is
                  the diagnostics surface, so labelled lists are fine here — the
                  in-message render stays a flat dimmed line. Empty sections are
                  omitted so it only shows what this turn actually observed. */}
              {(
                [
                  ['persistent', summary.persistent],
                  ['volatile', summary.volatile],
                  ['patterns', summary.established_patterns],
                ] as const
              ).map(([label, items]) =>
                items.length > 0 ? (
                  <div key={label} className="mt-2 first:mt-0">
                    <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg-4">
                      {label}
                    </div>
                    <ul className="mt-0.5 space-y-0.5">
                      {items.map((it, i) => (
                        <li key={i} className="text-[11px] leading-[1.4] text-fg-2">
                          {it}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null,
              )}
            </div>
          )}

          {turnData.stateTokens && (
            // Kept OUT of the Context-Savings tile on purpose (D12): that tile
            // compares memory curation, and a second call's usage would muddy
            // the comparison. It still gets said, just here.
            <div className="mt-2.5 font-mono text-[9.5px] tracking-[0.02em] text-fg-4">
              reflection · {turnData.stateTokens.input.toLocaleString()} in ·{' '}
              {turnData.stateTokens.output.toLocaleString()} out
            </div>
          )}
        </Card>
      )}

      {/* Portals to document.body — position in this tree is irrelevant to
          layout; it lives here because the selection state does. */}
      <RetrievalDetailModal selection={selection} onClose={() => setSelection(null)} />
    </section>
  );
});
