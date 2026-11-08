import { describe, expect, it } from 'vitest';
import { POLL_JITTER, RESUME_SPREAD_MS, jittered, resumeDelay } from './jitter';

describe('poll jitter', () => {
  it('stays within ±15 % and actually varies', () => {
    const samples = Array.from({ length: 500 }, () => jittered(30_000));
    for (const s of samples) {
      expect(s).toBeGreaterThanOrEqual(30_000 * (1 - POLL_JITTER));
      expect(s).toBeLessThanOrEqual(30_000 * (1 + POLL_JITTER));
    }
    expect(new Set(samples).size).toBeGreaterThan(100);
    expect(Math.min(...samples)).toBeLessThan(27_000);
    expect(Math.max(...samples)).toBeGreaterThan(33_000);
  });

  it('spreads resume refetches over 0–3 s', () => {
    const d = Array.from({ length: 300 }, resumeDelay);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...d)).toBeLessThanOrEqual(RESUME_SPREAD_MS);
    expect(Math.max(...d) - Math.min(...d)).toBeGreaterThan(2_000);
  });
});
