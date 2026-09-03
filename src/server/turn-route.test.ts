// @vitest-environment node
//
// Behavioral tests for /api/turn's reply-pacing integration (turn-route.ts +
// paragraph-cap.ts): a real Express app, a fake provider, real HTTP. Pins the
// contract the client relies on — the stream ends at the Nth paragraph break
// with stopReason 'max_paragraphs', the upstream call is aborted, an
// un-capped turn is byte-identical to before pacing, and a bad ceiling 400s
// before the stream opens.

import express from 'express';
import type { AddressInfo } from 'node:net';
import { registerTurnRoute } from './turn-route';
import type { TurnChunk, TurnProvider } from './provider-types';

interface Frame {
  event: string;
  data: Record<string, unknown>;
}

/** A provider that streams the given fragments, then a natural done frame.
 *  Records whether the route aborted it. */
function fakeProvider(fragments: string[]): { provider: TurnProvider; aborted: () => boolean } {
  let aborted = false;
  const provider: TurnProvider = {
    async *streamTurn(_system, _messages, _tools, signal): AsyncIterable<TurnChunk> {
      signal.addEventListener('abort', () => {
        aborted = true;
      });
      for (const f of fragments) {
        if (signal.aborted) return;
        yield { kind: 'delta', text: f };
      }
      yield { kind: 'done', usage: { inputTokens: 10, outputTokens: 20 }, stopReason: 'end_turn' };
    },
  };
  return { provider, aborted: () => aborted };
}

async function serve(provider: TurnProvider): Promise<{ url: string; close: () => Promise<void> }> {
  const app = express();
  app.use(express.json());
  registerTurnRoute(app, {
    providers: { openai: provider },
    providerAvailable: { anthropic: false, openai: true },
    defaultProvider: 'openai',
  });
  const server = await new Promise<import('node:http').Server>((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/api/turn`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

async function post(url: string, body: unknown): Promise<{ status: number; frames: Frame[]; json?: unknown }> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.headers.get('content-type')?.includes('text/event-stream')) {
    return { status: resp.status, frames: [], json: await resp.json() };
  }
  const raw = await resp.text();
  const frames: Frame[] = [];
  for (const block of raw.split('\n\n')) {
    const ev = /^event: (.*)$/m.exec(block);
    const data = /^data: (.*)$/m.exec(block);
    if (ev && data) frames.push({ event: ev[1], data: JSON.parse(data[1]) });
  }
  return { status: resp.status, frames };
}

const text = (frames: Frame[]) =>
  frames.filter((f) => f.event === 'delta').map((f) => f.data.text as string).join('');
const done = (frames: Frame[]) => frames.find((f) => f.event === 'done')?.data;

describe('/api/turn — reply pacing', () => {
  it('ends the stream at the Nth paragraph break, aborts upstream, reports max_paragraphs', async () => {
    const { provider, aborted } = fakeProvider(['One.\n', '\nTwo.\n\n', 'Three keeps going', ' and going']);
    const srv = await serve(provider);
    try {
      const { status, frames } = await post(srv.url, { system: 's', message: 'hi', maxParagraphs: 2 });
      expect(status).toBe(200);
      expect(text(frames)).toBe('One.\n\nTwo.');
      // Usage is unknown after a cut: null on the wire, never a measured 0.
      expect(done(frames)).toEqual({ inputTokens: null, outputTokens: null, stopReason: 'max_paragraphs' });
      expect(aborted()).toBe(true);
      // Exactly one done, nothing after it.
      expect(frames.filter((f) => f.event === 'done')).toHaveLength(1);
      expect(frames[frames.length - 1].event).toBe('done');
    } finally {
      await srv.close();
    }
  });

  it('passes an under-ceiling reply through byte-identical, with the real done frame', async () => {
    const { provider, aborted } = fakeProvider(['One.\n', '\nTwo.\n']);
    const srv = await serve(provider);
    try {
      const { frames } = await post(srv.url, { system: 's', message: 'hi', maxParagraphs: 3 });
      expect(text(frames)).toBe('One.\n\nTwo.\n'); // held-back trailing newline released
      expect(done(frames)).toEqual({ inputTokens: 10, outputTokens: 20, stopReason: 'end_turn' });
      expect(aborted()).toBe(false);
    } finally {
      await srv.close();
    }
  });

  it('applies no cap at all without maxParagraphs (the state turn path)', async () => {
    const { provider } = fakeProvider(['{\n\n', '"a": 1\n\n', '}\n\n\n\nmore']);
    const srv = await serve(provider);
    try {
      const { frames } = await post(srv.url, { system: 's', message: 'hi' });
      expect(text(frames)).toBe('{\n\n"a": 1\n\n}\n\n\n\nmore');
      expect(done(frames)?.stopReason).toBe('end_turn');
    } finally {
      await srv.close();
    }
  });

  it('rejects a malformed ceiling with a plain 400 before the stream opens', async () => {
    const { provider } = fakeProvider(['x']);
    const srv = await serve(provider);
    try {
      for (const bad of [0, -1, 2.5, '3', 51]) {
        const r = await post(srv.url, { system: 's', message: 'hi', maxParagraphs: bad });
        expect(r.status).toBe(400);
        expect((r.json as { error: string }).error).toMatch(/maxParagraphs/);
      }
    } finally {
      await srv.close();
    }
  });
});
