import { memo, useState } from 'react';
import { Plus } from 'lucide-react';
import type { Memory } from '../lib/types';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

// ============================================================
// MEMORY PANEL — Constitutional Memories.
// ============================================================

interface MemoryPanelProps {
  memories: Memory[];
  onUpdate: (id: string, newText: string) => void;
  onAdd: (text: string) => void;
  onRemove: (id: string) => void;
  // The live system-prompt version label + a handler to open the editor. Passed
  // as primitives (number + stable callback) rather than a ReactNode so this
  // memoized panel still skips re-renders during streaming / typing.
  promptVersionN: number;
  onOpenPromptEditor: () => void;
  // Disabled until the active chat id is ready (pre-hydration / mid chat-swap /
  // hydration failure) — there'd be no chat to scope the edit to.
  promptEditorDisabled: boolean;
}

export const MemoryPanel = memo(function MemoryPanel({
  memories,
  onUpdate,
  onAdd,
  onRemove,
  promptVersionN,
  onOpenPromptEditor,
  promptEditorDisabled,
}: MemoryPanelProps) {
  const [newMemText, setNewMemText] = useState('');

  const submitNew = () => {
    if (newMemText.trim()) {
      onAdd(newMemText.trim());
      setNewMemText('');
    }
  };

  return (
    <section className="flex flex-col gap-2.5">
      {/* Header: section label + the System Prompt editor button (top-right). */}
      <div className="mb-1 flex items-center justify-between gap-2.5">
        <span className="font-mono text-[11px] tracking-[0.18em] uppercase text-fg-3">
          Constitutional Memories
        </span>
        <button
          type="button"
          onClick={onOpenPromptEditor}
          disabled={promptEditorDisabled}
          aria-label="Edit this chat's system prompt"
          className="shrink-0 whitespace-nowrap rounded-md border border-hairline-strong px-2.5 py-1.5 font-mono text-[9.5px] uppercase tracking-[0.12em] text-ember transition-colors hover:border-ember/60 hover:bg-ember/[0.08] disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline-strong disabled:hover:bg-transparent"
        >
          <span className="text-fg-4">[</span> System Prompt{' '}
          <span className="text-fg-2">v{promptVersionN}</span>{' '}
          <span className="text-fg-4">]</span>
        </button>
      </div>

      <div className="flex flex-col gap-2.5">
        {memories.map((mem, i) => (
          <Card
            key={mem.id}
            className="gap-0 rounded-[14px] border px-[14px] pt-[14px] pb-3 shadow-none transition-colors"
          >
            <div className="mb-2 flex items-baseline justify-between font-mono text-[10.5px] tracking-[0.08em] text-fg-3">
              <span className="text-fg-2">M{i + 1}</span>
              <button
                className="cursor-pointer px-0.5 text-sm leading-none text-fg-4 transition-colors hover:text-danger"
                onClick={() => onRemove(mem.id)}
                aria-label="Remove memory"
              >×</button>
            </div>
            <div
              className="min-h-[18px] cursor-text rounded-[3px] text-[13px] leading-[1.5] text-fg-1 outline-none focus:ring-2 focus:ring-ember/40"
              contentEditable
              suppressContentEditableWarning
              onBlur={(e) => onUpdate(mem.id, e.currentTarget.textContent ?? '')}
            >{mem.text}</div>
          </Card>
        ))}
      </div>

      <div className="mt-1 flex gap-1.5">
        <input
          value={newMemText}
          onChange={(e) => setNewMemText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submitNew(); }}
          placeholder="Add memory..."
          className="flex-1 rounded-[10px] border bg-surface px-3 py-2 text-[12.5px] text-fg-1 outline-none placeholder:text-fg-4 focus:border-ember/45"
        />
        <Button
          variant="outline"
          size="icon"
          onClick={submitNew}
          aria-label="Add memory"
          className="size-8 rounded-[10px] text-ember"
        ><Plus className="size-3.5" /></Button>
      </div>
    </section>
  );
});
