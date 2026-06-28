// Structural guard for the operator deck. The deck is hand-edited data; these
// assertions turn "remember the conventions" into a check that fails loudly on a
// malformed edit (Core Value #3).

import { FLEX_DECK, operatorLabel } from './flexDeck';

describe('FLEX_DECK', () => {
  it('is non-empty', () => {
    expect(FLEX_DECK.length).toBeGreaterThan(0);
  });

  it('has unique ids', () => {
    const ids = FLEX_DECK.map((op) => op.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses snake_case ids', () => {
    for (const op of FLEX_DECK) {
      expect(op.id).toMatch(/^[a-z]+(_[a-z]+)*$/);
    }
  });

  it('gives every operator a positive weight', () => {
    for (const op of FLEX_DECK) {
      expect(op.weight).toBeGreaterThan(0);
    }
  });

  it('wraps every directive in the @!…!@ salience sigil', () => {
    for (const op of FLEX_DECK) {
      expect(op.directive).toMatch(/@!.+!@/);
      expect(op.directive).toContain('OPERATOR:');
    }
  });
});

describe('operatorLabel', () => {
  it('parses the human-facing name out of every deck directive', () => {
    for (const op of FLEX_DECK) {
      const label = operatorLabel(op.directive);
      expect(label.length).toBeGreaterThan(0);
      expect(label).not.toContain('@!');
      expect(label).not.toContain('OPERATOR:');
    }
  });

  it('reads the exact name from the sigil', () => {
    expect(operatorLabel('@!OPERATOR: Offscreen Life!@ — body text')).toBe('Offscreen Life');
    expect(operatorLabel('@!OPERATOR: Emotional Non-Sequitur!@ — x')).toBe('Emotional Non-Sequitur');
  });

  it('falls back to "Operator" when the sigil is missing', () => {
    expect(operatorLabel('no sigil here')).toBe('Operator');
  });
});
