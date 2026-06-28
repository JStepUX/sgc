// Behavioral tests for the slack detector. Same spirit as tfidf.test.ts: the
// detector is pure math, so its polarity, windowing, and edge cases are pinned
// here.

import { detectSlack, DEFAULT_SLACK_THRESHOLD } from './slackDetector';
import type { ChatEntry } from '../types';

/** Build one user+assistant turn pair. createdAt is required on ChatEntry but
 * irrelevant to the detector, so a fixed stamp is fine. */
function turn(user: string, assistant: string): ChatEntry[] {
  return [
    { role: 'user', content: user, createdAt: 0 },
    { role: 'assistant', content: assistant, createdAt: 0 },
  ];
}

describe('detectSlack', () => {
  it('returns a zero reading with fewer than two comparable turns', () => {
    expect(detectSlack([])).toEqual({ shouldFire: false, similarity: 0 });
    expect(detectSlack(turn('hello there', 'general kenobi'))).toEqual({
      shouldFire: false,
      similarity: 0,
    });
  });

  it('reports high similarity for near-identical recent turns and fires', () => {
    const log = [
      ...turn('tell me about the rainfall patterns', 'the rainfall patterns vary'),
      ...turn('more about the rainfall patterns please', 'rainfall patterns again'),
      ...turn('still discussing rainfall patterns here', 'rainfall patterns persist'),
    ];
    const reading = detectSlack(log);
    expect(reading.similarity).toBeGreaterThan(DEFAULT_SLACK_THRESHOLD);
    expect(reading.shouldFire).toBe(true);
  });

  it('reports low similarity for vocabulary-disjoint turns and does not fire', () => {
    const log = [
      ...turn('quantum chromodynamics lecture', 'gluons confine quarks'),
      ...turn('sourdough baking schedule', 'autolyse before kneading'),
      ...turn('alpine glacier retreat', 'moraine deposits widen'),
    ];
    const reading = detectSlack(log);
    expect(reading.similarity).toBeLessThan(DEFAULT_SLACK_THRESHOLD);
    expect(reading.shouldFire).toBe(false);
  });

  it('honors a configurable threshold (same data, flipped decision)', () => {
    const log = [
      ...turn('budget proposal review meeting', 'budget proposal looks fine'),
      ...turn('another budget proposal review', 'budget proposal approved'),
    ];
    const { similarity } = detectSlack(log);
    // Pick thresholds straddling the measured similarity.
    expect(detectSlack(log, { threshold: similarity - 0.01 }).shouldFire).toBe(true);
    expect(detectSlack(log, { threshold: similarity + 0.01 }).shouldFire).toBe(false);
  });

  it('windows to the last N turns — older dissimilar turns do not dilute', () => {
    const log = [
      ...turn('completely unrelated astronomy talk', 'nebulae and pulsars'),
      ...turn('repeating the same widget topic', 'widget topic widget topic'),
      ...turn('repeating the same widget topic', 'widget topic widget topic'),
    ];
    // Window of 2 sees only the two identical widget turns → high similarity.
    const windowed = detectSlack(log, { windowTurns: 2 });
    expect(windowed.similarity).toBeGreaterThan(DEFAULT_SLACK_THRESHOLD);
    // Window of 3 pulls in the unrelated astronomy turn → average drops.
    const wide = detectSlack(log, { windowTurns: 3 });
    expect(wide.similarity).toBeLessThan(windowed.similarity);
  });

  it('drops content-free turns rather than letting them skew the average', () => {
    const log = [
      ...turn('the and but', '!!! ???'), // tokenizes to nothing → dropped
      ...turn('shared topical vocabulary here', 'shared topical vocabulary'),
      ...turn('shared topical vocabulary again', 'shared topical vocabulary'),
    ];
    const reading = detectSlack(log);
    // Only the two real turns are compared; the empty one neither inflates nor
    // deflates the reading.
    expect(reading.similarity).toBeGreaterThan(0);
    expect(reading.shouldFire).toBe(true);
  });
});
