import { memo } from 'react';
import type { TokenHistoryEntry } from '../lib/turn-data';
import { RAIL_LABEL } from './rail-styles';

// ============================================================
// TOKEN CHART — payload size per turn.
// ============================================================

export const TokenChart = memo(function TokenChart({ tokenHistory }: { tokenHistory: TokenHistoryEntry[] }) {
  if (tokenHistory.length < 2) return null;

  const maxTokens = Math.max(...tokenHistory.map((t) => t.inputTokens), 1);
  const chartWidth = 280;
  const chartHeight = 60;
  const barWidth = Math.min(16, (chartWidth - tokenHistory.length * 2) / tokenHistory.length);
  const avg = tokenHistory.reduce((s, t) => s + t.inputTokens, 0) / tokenHistory.length;

  return (
    <section className="flex flex-col gap-2.5">
      <div className={RAIL_LABEL}>Payload Size per Turn</div>
      <svg width={chartWidth} height={chartHeight + 16} className="block">
        {tokenHistory.map((t, i) => {
          const h = (t.inputTokens / maxTokens) * chartHeight;
          const x = i * (barWidth + 2);
          return (
            <g key={i}>
              <rect x={x} y={chartHeight - h} width={barWidth} height={h} rx={2} fill="var(--color-ember-soft)" opacity={0.7} />
              <text x={x + barWidth / 2} y={chartHeight + 12} textAnchor="middle" fontSize="9" fill="var(--color-fg-3)" fontFamily="var(--font-mono)">{i + 1}</text>
            </g>
          );
        })}
        {tokenHistory.length > 2 && (
          <line
            x1={0} y1={chartHeight - (avg / maxTokens) * chartHeight}
            x2={chartWidth} y2={chartHeight - (avg / maxTokens) * chartHeight}
            stroke="var(--color-ember)" strokeDasharray="3,3" opacity={0.45}
          />
        )}
      </svg>
    </section>
  );
});
