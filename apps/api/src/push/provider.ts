import type { PushPayload } from '@fant/shared';
import webpush from 'web-push';

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushSendOptions {
  /** Seconds the push service keeps an undelivered message. */
  ttlSec: number;
  urgency: 'very-low' | 'low' | 'normal' | 'high';
}

/**
 * 'ok' = accepted by the push service · 'gone' = the subscription no longer exists (404/410 → delete it)
 * · 'error' = anything else (counted; deleted after repeated failures).
 */
export type PushSendResult = 'ok' | 'gone' | 'error';

/** Web push now; FCM / APNs providers for the native shells implement the same interface later. */
export interface PushProvider {
  send(subscription: PushTarget, payload: PushPayload, options?: PushSendOptions): Promise<PushSendResult>;
}

export const DEFAULT_PUSH_OPTIONS: PushSendOptions = { ttlSec: 24 * 3600, urgency: 'normal' };

export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export class WebPushProvider implements PushProvider {
  constructor(
    private readonly vapid: VapidConfig,
    private readonly onError?: (statusCode: number | null, message: string) => void,
  ) {}

  async send(
    subscription: PushTarget,
    payload: PushPayload,
    options: PushSendOptions = DEFAULT_PUSH_OPTIONS,
  ): Promise<PushSendResult> {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: this.vapid,
          TTL: options.ttlSec,
          urgency: options.urgency,
          timeout: 15_000,
        },
      );
      return 'ok';
    } catch (err) {
      const status =
        typeof err === 'object' && err !== null && 'statusCode' in err && typeof err.statusCode === 'number'
          ? err.statusCode
          : null;
      if (status === 404 || status === 410) return 'gone';
      // Never log the endpoint (it is a capability URL).
      this.onError?.(status, err instanceof Error ? err.message : String(err));
      return 'error';
    }
  }
}
