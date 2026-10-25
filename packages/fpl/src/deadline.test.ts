import { BootstrapSchema } from '@fant/shared';
import { describe, expect, it } from 'vitest';
import { rawBootstrap, rawEvent, standardSquad } from './__fixtures__/mini.js';
import { currentOrNextEvent, lastStartedEvent, nextDeadline } from './deadline.js';
import { mapBootstrap } from './normalize.js';
import { RawBootstrapSchema } from './raw.js';

const bootstrapWith = (events: ReturnType<typeof rawEvent>[]) =>
  mapBootstrap(RawBootstrapSchema.parse(rawBootstrap(standardSquad(), events)), 0);

describe('deadline helpers', () => {
  const events = bootstrapWith([
    rawEvent(1, { finished: true, deadline: '2025-08-15T17:30:00Z' }),
    rawEvent(2, { current: true, deadline: '2025-08-22T17:30:00Z' }),
    rawEvent(3, { deadline: '2025-08-30T10:00:00Z' }),
  ]).events;

  it('nextDeadline returns the first future deadline', () => {
    const now = Date.parse('2025-08-25T00:00:00Z');
    expect(nextDeadline(events, now)).toEqual({
      event: 3,
      deadlineTime: '2025-08-30T10:00:00.000Z',
      msUntil: Date.parse('2025-08-30T10:00:00Z') - now,
    });
    expect(nextDeadline(events, Date.parse('2025-09-01T00:00:00Z'))).toBeNull();
    // exactly at a deadline → that deadline has passed
    expect(nextDeadline(events, Date.parse('2025-08-22T17:30:00Z'))?.event).toBe(3);
  });

  it('lastStartedEvent returns the latest passed deadline', () => {
    expect(lastStartedEvent(events, Date.parse('2025-08-25T00:00:00Z'))).toBe(2);
    expect(lastStartedEvent(events, Date.parse('2025-08-01T00:00:00Z'))).toBeNull();
  });

  it('currentOrNextEvent: current, else next (pre-season), else last', () => {
    expect(
      currentOrNextEvent(bootstrapWith([rawEvent(1, { finished: true }), rawEvent(2, { current: true })])),
    ).toBe(2);
    const preSeason = BootstrapSchema.parse({
      ...bootstrapWith([rawEvent(1)]),
      currentEvent: null,
      nextEvent: 1,
    });
    expect(currentOrNextEvent(preSeason)).toBe(1);
    const over = BootstrapSchema.parse({
      ...bootstrapWith([rawEvent(1), rawEvent(2)]),
      currentEvent: null,
      nextEvent: null,
    });
    expect(currentOrNextEvent(over)).toBe(2);
  });
});
