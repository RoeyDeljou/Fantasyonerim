import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import { DbActivity } from './dbActivity.js';

const MINUTE = 60_000;

describe('DbActivity', () => {
  it('estimates awake minutes as the union of 5-minute windows after each query', () => {
    let now = 0;
    const db = new DbActivity(() => now);
    db.record(); // [0, 5)
    now = 2 * MINUTE;
    db.record(); // extends to 7
    now = 20 * MINUTE;
    db.record(); // [20, 25)
    expect(db.snapshot()).toMatchObject({ queries: 3, awakeMinutes: 12 });
  });

  it('is "awake" only right after a query; logs one summary line per hour', () => {
    let now = 0;
    const db = new DbActivity(() => now);
    expect(db.isAwake()).toBe(false);
    db.record();
    now = 30_000;
    expect(db.isAwake()).toBe(true);
    now = 2 * MINUTE;
    expect(db.isAwake()).toBe(false);

    const lines: unknown[] = [];
    const log = { info: (obj: unknown) => lines.push(obj) } as unknown as FastifyBaseLogger;
    expect(db.maybeLogHourly(log)).toBe(false);
    now = 60 * MINUTE;
    expect(db.maybeLogHourly(log)).toBe(true);
    expect(lines[0]).toMatchObject({ db: { queries: 1, awakeMinutes: 5 } });
    expect(db.maybeLogHourly(log)).toBe(false);
  });
});
