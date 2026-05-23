// ============================================================
// rehype-quotes — color double-quoted dialogue in Sal's markdown.
//
// Walks the HAST tree, splits text nodes on "..." / “...” spans, and wraps
// each match in <span class="text-ember">. Descendants of <code> / <pre> are
// skipped so code samples keep their literal quotes. Quotes that wrap markdown
// formatting (e.g. "What the **hell**?") are deliberately *not* covered — the
// bold tag splits the run across sibling text nodes and a stateful walker is
// not worth the failure surface for an edge case Sal almost never emits.
// ============================================================

// Match an opening quote, at least one non-quote / non-newline character, then
// a closing quote. Straight (U+0022) and curly pairs (U+201C / U+201D) both
// open and close; mixed pairs are tolerated rather than rejected.
const QUOTE_RE = /["“”][^"“”\n]+["“”]/gu;

const SKIP_TAGS = new Set(['code', 'pre']);

interface TextNode {
  type: 'text';
  value: string;
}

interface ElementNode {
  type: 'element';
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastChild[];
}

type HastChild = TextNode | ElementNode | { type: string; [k: string]: unknown };

interface HastRoot {
  type: 'root';
  children: HastChild[];
}

/**
 * Split a single text value into a sequence of text + span nodes. Exported
 * for unit testing — the walker itself is dead-simple recursion.
 */
export function splitDialogue(value: string): HastChild[] {
  const matches = [...value.matchAll(QUOTE_RE)];
  if (matches.length === 0) return [{ type: 'text', value }];

  const out: HastChild[] = [];
  let cursor = 0;
  for (const m of matches) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (start > cursor) {
      out.push({ type: 'text', value: value.slice(cursor, start) });
    }
    out.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['text-ember-bright'] },
      children: [{ type: 'text', value: m[0] }],
    });
    cursor = end;
  }
  if (cursor < value.length) {
    out.push({ type: 'text', value: value.slice(cursor) });
  }
  return out;
}

function walk(node: HastRoot | ElementNode, skip: boolean): void {
  const next: HastChild[] = [];
  for (const child of node.children) {
    if (child.type === 'element') {
      const el = child as ElementNode;
      walk(el, skip || SKIP_TAGS.has(el.tagName));
      next.push(el);
    } else if (child.type === 'text' && !skip) {
      next.push(...splitDialogue((child as TextNode).value));
    } else {
      next.push(child);
    }
  }
  node.children = next;
}

export default function rehypeQuotes() {
  return (tree: HastRoot) => {
    walk(tree, false);
  };
}
