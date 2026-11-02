import { setImmediate as nextTurn } from 'node:timers/promises';

/**
 * Lets pending I/O (user requests) run between chunks of a long synchronous-ish loop. Cached FplService reads
 * resolve through microtasks only, so a loop over 100+ managers would otherwise hold the event loop for its
 * whole duration — at 0.1 CPU, 10 ms of work is ~100 ms of wall time nobody else gets.
 */
export function createYielder(every = 10): () => Promise<void> {
  let n = 0;
  return async () => {
    n += 1;
    if (n % every === 0) await nextTurn();
  };
}
