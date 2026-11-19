'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { bridgeOrigin, FplLadBridge, prefsAuthStorage, REPLAY_DELAYS_MS } from '@/lib/assistant/fplLadBridge';

function clearTimers(ids: number[]): void {
  for (const id of ids) window.clearTimeout(id);
  ids.length = 0;
}

/**
 * Wires the FPL Lad /chat host bridge (lib/assistant/fplLadBridge.ts) to the panel's iframe while it is mounted:
 * listens to window `message` events and replays the stored FPL Lad sign-in into the frame. Returns the iframe's
 * `onLoad`. No-op when `fallbackUrl` isn't on fpl-lad.com.
 */
export function useFplLadBridge(
  frame: RefObject<HTMLIFrameElement | null>,
  fallbackUrl: string,
  active: boolean,
): () => void {
  const bridge = useRef<FplLadBridge | null>(null);
  const timers = useRef<number[]>([]);
  const origin = bridgeOrigin(fallbackUrl);

  useEffect(() => {
    if (!active || !origin) return;
    const b = new FplLadBridge({
      origin,
      frame: () => frame.current?.contentWindow ?? null,
      storage: prefsAuthStorage,
      now: () => Date.now(),
    });
    bridge.current = b;
    const onMessage = (e: MessageEvent) => {
      b.onMessage(e);
    };
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('message', onMessage);
      clearTimers(timers.current);
      if (bridge.current === b) bridge.current = null;
    };
  }, [active, origin, frame]);

  return useCallback(() => {
    const b = bridge.current;
    if (!b) return;
    b.onFrameLoad();
    clearTimers(timers.current);
    timers.current = REPLAY_DELAYS_MS.map((ms) => window.setTimeout(() => b.onReplayTimer(), ms));
  }, []);
}
