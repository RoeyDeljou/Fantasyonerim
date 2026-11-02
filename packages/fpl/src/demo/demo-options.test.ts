import { describe, expect, it, vi } from 'vitest';
import type * as Client from '../client.js';
import { createDemoFplService } from './index.js';

// The demo data has no unknown stat identifiers, so check the wiring: onWarn reaches createFplService.
const seen = vi.hoisted(() => ({ options: [] as unknown[] }));
vi.mock('../client.js', async (importOriginal) => {
  const actual = await importOriginal<typeof Client>();
  return {
    ...actual,
    createFplService: (options: Parameters<typeof actual.createFplService>[0]) => {
      seen.options.push(options);
      return actual.createFplService(options);
    },
  };
});

describe('createDemoFplService options', () => {
  it('forwards onWarn to createFplService', () => {
    const onWarn = vi.fn();
    createDemoFplService({ now: () => Date.UTC(2026, 9, 25), onWarn });
    expect(seen.options.at(-1)).toMatchObject({ onWarn });
  });
});
