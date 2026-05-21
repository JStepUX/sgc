// Tests for the pure helpers in api.ts. The network functions (runTurn,
// fetchUrl) are exercised end-to-end against the live server, not here; this
// file pins extractUrls, which decides which links get pre-fetched and is the
// kind of regex that quietly mangles real-world URLs if left untested.

import { extractUrls } from './api';

describe('extractUrls', () => {
  it('pulls a bare http(s) URL out of prose', () => {
    expect(extractUrls('see https://example.com/post for more')).toEqual([
      'https://example.com/post',
    ]);
  });

  it('keeps balanced parentheses in the path (Wikipedia regression)', () => {
    const url = 'https://en.wikipedia.org/wiki/Stack_(abstract_data_type)';
    expect(extractUrls(`read ${url} please`)).toEqual([url]);
  });

  it('strips an unbalanced closing paren when the link is wrapped in prose', () => {
    expect(extractUrls('(see https://example.com/p)')).toEqual(['https://example.com/p']);
  });

  it('trims trailing sentence punctuation', () => {
    expect(extractUrls('go to https://example.com/a.')).toEqual(['https://example.com/a']);
    expect(extractUrls('https://example.com/a, then stop')).toEqual(['https://example.com/a']);
  });

  it('keeps a balanced paren even when a sentence period follows', () => {
    const text = 'see https://en.wikipedia.org/wiki/Stack_(data).';
    expect(extractUrls(text)).toEqual(['https://en.wikipedia.org/wiki/Stack_(data)']);
  });

  it('dedupes and preserves order', () => {
    const text = 'https://a.com and https://b.com and https://a.com again';
    expect(extractUrls(text)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('caps the number of URLs returned', () => {
    const text = 'https://a.com https://b.com https://c.com https://d.com';
    expect(extractUrls(text, 2)).toEqual(['https://a.com', 'https://b.com']);
  });

  it('returns nothing when there is no URL', () => {
    expect(extractUrls('just some plain text, no links here')).toEqual([]);
  });
});
