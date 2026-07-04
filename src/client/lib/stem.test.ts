// Reference spot-checks for the Porter wrapper. Outputs are correct but
// surprising ('eleph', 'rainfal') — these literals document the behavior so
// nobody "fixes" it, and the collision/non-collision pairs pin exactly what
// stemming buys (regular inflection) and what it cannot (irregular forms).

import { describe, it, expect } from 'vitest';
import { stem } from './stem';

describe('stem', () => {
  it('produces reference Porter outputs (surprising but correct)', () => {
    expect(stem('elephant')).toBe('eleph');
    expect(stem('rainfall')).toBe('rainfal');
  });

  it('collides regular plural inflection: needles/needle', () => {
    expect(stem('needles')).toBe(stem('needle'));
  });

  it('collides regular verb inflection: painted/painting/paint', () => {
    expect(stem('painted')).toBe(stem('paint'));
    expect(stem('painting')).toBe(stem('paint'));
  });

  it('does NOT collide irregular forms: ran/running (ablaut has no suffix to strip)', () => {
    expect(stem('ran')).not.toBe(stem('running'));
  });

  it('is idempotent over the sample set: stem(stem(w)) === stem(w)', () => {
    const samples = [
      'elephant', 'rainfall', 'needles', 'needle',
      'painted', 'painting', 'paint', 'ran', 'running',
    ];
    for (const w of samples) {
      expect(stem(stem(w)), w).toBe(stem(w));
    }
  });
});
