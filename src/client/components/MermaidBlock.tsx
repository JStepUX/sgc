import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

// Lazy, one-time mermaid loader. The dynamic import() makes Vite split mermaid
// (a heavy dep — ~110 packages) into its own chunk that only downloads the first
// time a diagram actually appears, keeping it out of the main bundle.
let mermaidPromise: Promise<typeof import('mermaid').default> | null = null;

function loadMermaid() {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((mod) => {
      const mermaid = mod.default;
      mermaid.initialize({
        startOnLoad: false,
        // 'strict' runs mermaid's output through DOMPurify, so the SVG we inject
        // below via dangerouslySetInnerHTML is sanitized at the source.
        securityLevel: 'strict',
        theme: 'base',
        fontFamily: 'ui-sans-serif, system-ui, sans-serif',
        // Mapped to the Sal design tokens (src/client/index.css) so diagrams sit
        // in the warm near-black field instead of mermaid's default palette.
        themeVariables: {
          background: '#0a0907', // --color-ground
          primaryColor: '#1c1611', // node fill (warm dark surface over ground)
          primaryTextColor: '#ece2d0', // --color-fg-1
          primaryBorderColor: '#6b5d4c', // ~ --color-fg-4 / fg-3
          secondaryColor: '#14110d',
          tertiaryColor: '#1c1611',
          mainBkg: '#1c1611',
          nodeBorder: '#6b5d4c',
          lineColor: '#8e8270', // --color-fg-3 (edges)
          textColor: '#ece2d0', // --color-fg-1
          clusterBkg: '#14110d',
          clusterBorder: '#3a332a',
          edgeLabelBackground: '#14110d',
          noteBkgColor: '#1c1611',
          noteTextColor: '#ece2d0',
          noteBorderColor: '#6b5d4c',
          fontSize: '13px',
        },
      });
      return mermaid;
    });
  }
  return mermaidPromise;
}

// Per-instance render id. mermaid.render needs a unique DOM id; we hand it one
// rather than letting it collide across diagrams on the page.
let idCounter = 0;

/**
 * Renders a single ```mermaid fenced block as an SVG diagram.
 *
 * Only mounted for *finalized* turns (the markdown override gates on !streaming),
 * so the source is always complete when we attempt a render. Invalid syntax
 * degrades gracefully to the same styled code block the rest of the chat uses —
 * a diagram never crashes a message.
 */
export function MermaidBlock({ code }: { code: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const idRef = useRef<string | null>(null);
  if (!idRef.current) idRef.current = `mmd-${idCounter++}`;

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);
    (async () => {
      try {
        const mermaid = await loadMermaid();
        const { svg: out } = await mermaid.render(idRef.current!, code);
        if (!cancelled) setSvg(out);
      } catch {
        // Bad/unsupported diagram syntax — fall back to showing the source.
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (failed) {
    return (
      <pre className="m-0 overflow-x-auto rounded-md border border-hairline-strong bg-surface-strong p-3">
        <code className="block font-mono text-[12.5px] leading-relaxed">{code}</code>
      </pre>
    );
  }

  if (!svg) {
    return (
      <div className="rounded-md border border-hairline-strong bg-surface-strong px-3 py-2.5 font-mono text-[11.5px] tracking-wide text-fg-3">
        rendering diagram…
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mermaid-diagram overflow-x-auto rounded-md border border-hairline bg-surface-thin p-3',
        '[&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full',
      )}
      // SVG is mermaid output sanitized under securityLevel: 'strict'.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
