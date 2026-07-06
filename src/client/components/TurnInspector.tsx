import { memo } from 'react';
import type { TurnData } from '../lib/turn-data';
import { operatorLabel } from '../lib/spontaneity/flexDeck';
import { DEFAULT_SLACK_THRESHOLD } from '../lib/spontaneity/slackDetector';
import { RAIL_LABEL, RAIL_SUB } from './rail-styles';
import { Card } from '@/components/ui/card';

// ============================================================
// TURN INSPECTOR — Architecture Trace, status, citations, deltas.
// ============================================================

export const TurnInspector = memo(function TurnInspector({ turnData }: { turnData: TurnData | null }) {
  if (!turnData) {
    return <div className="py-2 text-[12.5px] italic text-fg-3">Nothing yet. Say something.</div>;
  }

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
            {typeof turnData.apiCalls === 'number' ? ` (${turnData.apiCalls} API calls)` : ''}
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
            <Card
              key={i}
              className="gap-0 rounded-[4px_10px_10px_4px] border border-l-2 border-l-ember px-3 py-2.5 shadow-none"
            >
              <div className="mb-1 flex items-baseline gap-3 font-mono text-[10.5px] text-fg-3">
                <span className="font-medium text-fg-1">Turn {g.turnIndex}</span>
                <span>score: {g.score.toFixed(3)}</span>
              </div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-[1.5] text-fg-2">
                {g.preview}
              </div>
            </Card>
          ))}
        </div>
      )}

      {turnData.knowledgeDetails && turnData.knowledgeDetails.length > 0 && (
        <div className="mt-1 flex flex-col gap-2">
          {turnData.knowledgeDetails.map((k, i) => (
            // Same card idiom as a grep match — provenance line (brain ·
            // document · score), then the fragment preview.
            <Card
              key={i}
              className="gap-0 rounded-[4px_10px_10px_4px] border border-l-2 border-l-ember px-3 py-2.5 shadow-none"
            >
              <div className="mb-1 flex items-baseline gap-3 font-mono text-[10.5px] text-fg-3">
                <span className="font-medium text-fg-1">{k.brainName}</span>
                <span className="overflow-hidden text-ellipsis whitespace-nowrap">{k.title}</span>
                <span className="shrink-0">score: {k.score.toFixed(3)}</span>
              </div>
              <div className="overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-[1.5] text-fg-2">
                {k.preview}
              </div>
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

      {(() => {
        // Context-savings card — the thesis of Phase 1.5 made legible.
        //
        // Left: what we actually sent (real `usage.input_tokens` from the API).
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
        // Old turns predate the field; the base loop is 1 call. Recall turns
        // bill each round's input, so Sent reads visibly larger on them —
        // expected, and worth saying rather than leaving the number odd.
        const apiCalls = turnData.apiCalls ?? 1;
        const callsLine = apiCalls === 1
          ? '1 API call this turn — Sal only.'
          : `${apiCalls} API calls this turn — Sal paused to remember (tokens are summed across rounds).`;
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
                      Sent
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
                <div className="mt-1.5 font-mono text-[22px] font-semibold text-ember">{apiCalls}</div>
                <div className="mt-0.5 text-[10.5px] text-fg-3">
                  {apiCalls === 1 ? 'Sal only. Grep is TF-IDF (0 ms).' : 'Sal paused to remember. Retrieval is still TF-IDF (0 ms).'}
                </div>
              </>
            )}
          </Card>
        );
      })()}

      {turnData.summary &&
        (turnData.summary.persistent.length > 0 ||
          turnData.summary.volatile.length > 0 ||
          turnData.summary.established_patterns.length > 0) && (
          <Card className="gap-0 rounded-xl border px-[14px] py-3 shadow-none">
            {/* The structured view of Sal's per-turn summary. The inspector is
                the diagnostics surface, so labelled lists are fine here — the
                in-message render stays a flat dimmed line. Empty sections are
                omitted so the card only shows what this turn actually observed. */}
            <div className={RAIL_SUB}>Turn Summary</div>
            {(
              [
                ['persistent', turnData.summary.persistent],
                ['volatile', turnData.summary.volatile],
                ['patterns', turnData.summary.established_patterns],
              ] as const
            ).map(([label, items]) =>
              items.length > 0 ? (
                <div key={label} className="mt-2">
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
          </Card>
        )}
    </section>
  );
});
