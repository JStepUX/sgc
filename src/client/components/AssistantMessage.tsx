import { isValidElement, memo } from 'react';
import { Pencil, Undo2 } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeQuotes from '../lib/rehype-quotes';
import { MermaidBlock } from './MermaidBlock';
import type { TurnSummary } from '../lib/types';
import { cn } from '@/lib/utils';

// ============================================================
// ASSISTANT MESSAGE — Sal's reply block in the reading column.
// ============================================================

// Flatten a turn summary into one natural-language line ("a, b, and c"). All
// three sections are concatenated in order — the in-message render deliberately
// drops the section labels (those live in the inspector's structured card) to
// stay a single ultra-subtle line that respects the reading column's vertical
// space. Returns '' when the turn observed nothing, so nothing renders.
function flattenSummary(s: TurnSummary): string {
  const items = [...s.persistent, ...s.volatile, ...s.established_patterns];
  if (items.length === 0) return '';
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// Memoized so finalized messages don't re-run ReactMarkdown on every parent
// re-render (typing, pulse-key bumps, streaming token arrival). Only the
// in-flight streaming bubble re-renders as its `text` grows.
export const AssistantMessage = memo(function AssistantMessage({
  text,
  streaming = false,
  label,
  summary,
  spontaneity,
  onEdit,
  canEdit = false,
  onUndo,
  canUndo = false,
}: {
  text: string;
  streaming?: boolean;
  /** Display-only author label for this turn. Falls back to "Sal" when empty.
   * NEVER sourced from / sent to the model — this is the per-chat mask. */
  label?: string;
  /** Sal's per-turn summary, rendered as a dimmed one-line appendage beneath the
   * reply. Absent while streaming and on turns that observed nothing. */
  summary?: TurnSummary;
  /** The spontaneity operator that fired this turn, rendered as a dimmed "⟐ Name"
   * marker so a perturbed turn is recognizable at a glance. Absent while streaming
   * and on turns where nothing fired. Full detail lives in the inspector. */
  spontaneity?: { label: string };
  /** Open the response editor for this turn. Present only on the latest reply. */
  onEdit?: () => void;
  /** Whether the pencil is actionable (turn persisted + no turn in progress). */
  canEdit?: boolean;
  /** Undo this turn: delete the pair, return the user's text to the composer.
   * Present only on the latest reply, same scope as onEdit. */
  onUndo?: () => void;
  /** Same gate as canEdit — the pair needs a DB id and an idle session. */
  canUndo?: boolean;
}) {
  const name = label && label.trim() ? label : 'Sal';
  const summaryLine = summary ? flattenSummary(summary) : '';
  return (
    <div
      className={cn(
        'group relative flex flex-col gap-2 text-pretty text-[15px] font-light leading-[1.7] text-fg-1',
        streaming && 'sal-streaming',
      )}
    >
      <span className="font-mono text-[10.5px] tracking-[0.18em] uppercase text-fg-3">
        {name}
      </span>
      {!streaming && (onEdit || onUndo) && (
        // Hover-revealed controls on the latest reply: the pencil opens the
        // response editor (manual edit / re-spin); the undo arrow takes the
        // whole turn back (pair deleted, user text returned to the composer).
        // Both disabled until the turn has a DB id and no turn is in flight,
        // so every action has an addressable target.
        <div className="absolute right-0 top-0 flex gap-1.5">
          {onUndo && (
            <button
              type="button"
              onClick={onUndo}
              disabled={!canUndo}
              aria-label="Undo this turn"
              title="Undo this turn — your message returns to the composer"
              className="flex size-[26px] items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-3 opacity-0 transition-opacity hover:border-ember hover:text-ember group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
            >
              <Undo2 className="size-[12.5px]" />
            </button>
          )}
          {onEdit && (
            <button
              type="button"
              onClick={onEdit}
              disabled={!canEdit}
              aria-label="Edit this response"
              title="Edit this response"
              className="flex size-[26px] items-center justify-center rounded-full border border-hairline-strong bg-surface-thin text-fg-3 opacity-0 transition-opacity hover:border-ember hover:text-ember group-hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-0"
            >
              <Pencil className="size-[12.5px]" />
            </button>
          )}
        </div>
      )}
      <div className="flex flex-col gap-3.5">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeQuotes]}
        components={{
          p: ({ node: _node, ...props }) => (
            <p {...props} className="m-0 whitespace-pre-wrap" />
          ),
          a: ({ node: _node, ...props }) => (
            <a
              {...props}
              target="_blank"
              rel="noopener noreferrer"
              className="text-ember-soft underline decoration-ember/40 underline-offset-2 hover:decoration-ember"
            />
          ),
          ul: ({ node: _node, ...props }) => (
            <ul {...props} className="m-0 ml-5 list-disc space-y-1" />
          ),
          ol: ({ node: _node, ...props }) => (
            <ol {...props} className="m-0 ml-5 list-decimal space-y-1" />
          ),
          li: ({ node: _node, ...props }) => (
            <li {...props} className="leading-[1.55]" />
          ),
          strong: ({ node: _node, ...props }) => (
            <strong {...props} className="font-medium text-fg-1" />
          ),
          em: ({ node: _node, ...props }) => <em {...props} className="italic" />,
          code: ({ node: _node, className: cls, children, ...props }) => {
            // Finalized turns render a ```mermaid block as a diagram. While the
            // turn is still streaming the source is incomplete (mermaid would
            // throw), so we let it fall through to the normal code-block path
            // and only swap to the diagram once the turn closes.
            if (!streaming && /language-mermaid/.test(cls || '')) {
              return <MermaidBlock code={String(children).replace(/\n$/, '')} />;
            }
            const isBlock =
              /language-/.test(cls || '') || String(children).includes('\n');
            if (isBlock) {
              return (
                <code
                  {...props}
                  className={cn(cls, 'block font-mono text-[12.5px] leading-relaxed')}
                >
                  {children}
                </code>
              );
            }
            return (
              <code
                {...props}
                className="rounded bg-surface-strong px-1 py-0.5 font-mono text-[0.88em]"
              >
                {children}
              </code>
            );
          },
          pre: ({ node: _node, children, ...props }) => {
            // A finalized mermaid block becomes a diagram with its own
            // container — strip the code-box chrome so it isn't double-framed.
            const childClass = isValidElement(children)
              ? ((children.props as { className?: string }).className ?? '')
              : '';
            if (!streaming && /language-mermaid/.test(childClass)) {
              return <>{children}</>;
            }
            return (
              <pre
                {...props}
                className="m-0 overflow-x-auto rounded-md border border-hairline-strong bg-surface-strong p-3"
              >
                {children}
              </pre>
            );
          },
          blockquote: ({ node: _node, ...props }) => (
            <blockquote
              {...props}
              className="m-0 border-l-2 border-hairline-strong pl-3 italic text-fg-2"
            />
          ),
          h1: ({ node: _node, ...props }) => (
            <h1 {...props} className="m-0 text-[17px] font-medium tracking-[-0.005em] text-fg-1" />
          ),
          h2: ({ node: _node, ...props }) => (
            <h2 {...props} className="m-0 text-base font-medium tracking-[-0.005em] text-fg-1" />
          ),
          h3: ({ node: _node, ...props }) => (
            <h3 {...props} className="m-0 text-[15px] font-medium text-fg-1" />
          ),
          hr: ({ node: _node, ...props }) => (
            <hr {...props} className="m-0 border-hairline-strong" />
          ),
        }}
      >
        {text}
      </ReactMarkdown>
      </div>
      {summaryLine && (
        // Ultra-subtle, always-on debug line: Sal's per-turn summary flattened
        // to one dimmed row. Recessive by design — present for inspection, not
        // chrome the reader has to engage with each turn.
        <div className="text-[11px] font-normal leading-[1.45] text-fg-4/70">
          {summaryLine}
        </div>
      )}
      {!streaming && spontaneity && (
        // The spontaneity marker — same recessive register as the summary line,
        // with an ember-tinted ⟐ so a perturbed turn is spottable when scrolling.
        // Name only; the directive + slack reading live in the inspector card.
        <div className="text-[11px] font-normal leading-[1.45] text-fg-4/70">
          <span className="text-ember/60">⟐</span> {spontaneity.label}
        </div>
      )}
    </div>
  );
});
