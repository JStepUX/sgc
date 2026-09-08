import { memo } from 'react';
import { flattenSheetForPrompt, type ContinuitySheet } from '../lib/continuity';
import { RAIL_SUB } from './rail-styles';
import { Card } from '@/components/ui/card';

// ============================================================
// CONTINUITY CARD — the scene's continuity sheet, read-only (spec 07).
//
// Sits ABOVE the Dynamic State card in the rail because the sheet is the
// state turn's first-class output. Read-only by design: correction is
// diegetic (the person corrects the story; the next state turn applies it),
// so the rail shows what Sal believes without asking anyone to babysit it.
// Rendered from the same flattener the prompt uses, so the card and the
// prompt agree line for line. Split out of TurnInspector by the
// anti-god-object ratchet (src/architecture.test.ts).
// ============================================================

interface ContinuityCardProps {
  /** The sheet the next prompt will read — the fold of the whole log. */
  sheet: ContinuitySheet | null;
  /** What THIS turn's reflection contributed: 'changed' (a delta with slots),
   *  'unchanged' (an explicit empty delta — a successful observation of no
   *  change), or 'unrecorded' (no usable block landed — a failed or
   *  unparseable reflection). The last two are different facts and are
   *  labelled differently (Astra, 2026-09-07). */
  thisTurn: 'changed' | 'unchanged' | 'unrecorded';
}

const SECTION_LABEL = 'mt-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg-4';

export const ContinuityCard = memo(function ContinuityCard({ sheet, thisTurn }: ContinuityCardProps) {
  const lines = flattenSheetForPrompt(sheet)
    .split('\n')
    .filter((line) => line.trim().length > 0);

  // Always present once there is a turn to inspect — an empty card that says
  // so beats an absent one, which reads as "the feature isn't here" (James,
  // first eyes-on run, 2026-09-07). Same discipline as the Dynamic State card.
  if (lines.length === 0) {
    return (
      <Card className="gap-0 rounded-xl border px-[14px] py-3 shadow-none">
        <div className={RAIL_SUB}>Continuity</div>
        <div className="mt-2 text-[11px] leading-[1.4] text-fg-4">
          {thisTurn === 'unrecorded'
            ? '(nothing established yet — the last reflection recorded no scene)'
            : '(nothing established yet — forms as the story does)'}
        </div>
      </Card>
    );
  }

  return (
    <Card className="gap-0 rounded-xl border px-[14px] py-3 shadow-none">
      <div className={RAIL_SUB}>Continuity</div>
      {thisTurn !== 'changed' && (
        <div className="mt-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-fg-4">
          {thisTurn === 'unchanged' ? 'no changes this turn' : 'nothing recorded this turn'}
        </div>
      )}
      <div className="mt-2 flex flex-col gap-0.5">
        {lines.map((line, i) => {
          const text = line.trim();
          // "present:" / "elsewhere:" are the flattener's section headers;
          // character rows sit under them at a deeper indent.
          const isSection = text === 'present:' || text === 'elsewhere:';
          return isSection ? (
            <div key={i} className={SECTION_LABEL}>
              {text.slice(0, -1)}
            </div>
          ) : (
            <div key={i} className={`text-[11px] leading-[1.45] text-fg-2${line.startsWith('    ') ? ' pl-3' : ''}`}>
              {text}
            </div>
          );
        })}
      </div>
    </Card>
  );
});
