import type { AdminPushHealth, PushService } from '@fant/shared';

/** Push service of a subscription endpoint, from its host only (never log or return the endpoint itself). */
export function pushServiceOf(endpoint: string): PushService {
  let host: string;
  try {
    host = new URL(endpoint).hostname.toLowerCase();
  } catch {
    return 'other';
  }
  if (host === 'web.push.apple.com' || host.endsWith('.push.apple.com')) return 'apple';
  if (host === 'fcm.googleapis.com' || host === 'android.googleapis.com') return 'google';
  if (host.endsWith('push.services.mozilla.com')) return 'mozilla';
  if (host.endsWith('.notify.windows.com')) return 'microsoft';
  return 'other';
}

export type PushBatch = AdminPushHealth['recent'][number];

export interface PushBatchLine extends PushBatch {
  recipients: number;
  services: Partial<Record<PushService, number>>;
}

interface BatchLogger {
  info(obj: object, msg: string): void;
}

export const RECENT_PUSH_BATCHES = 10;

/**
 * The last notification batches, in memory (one Render instance; lost on restart/redeploy — it's a diagnosis
 * aid, not an audit log), and one structured log line per batch. Counts and service names only: no endpoint,
 * key or user id is ever logged or kept here.
 */
export class PushBatchRecorder {
  private readonly batches: PushBatch[] = [];
  private logger: BatchLogger | null = null;

  setLogger(logger: BatchLogger): void {
    this.logger = logger;
  }

  record(line: PushBatchLine): void {
    this.logger?.info(
      {
        push: {
          kind: line.kind,
          recipients: line.recipients,
          devices: line.devices,
          delivered: line.delivered,
          gone: line.gone,
          failed: line.failed,
          failureCodes: line.failureCodes,
          services: line.services,
        },
      },
      'push batch',
    );
    const { recipients: _r, services: _s, ...batch } = line;
    this.batches.unshift(batch);
    this.batches.length = Math.min(this.batches.length, RECENT_PUSH_BATCHES);
  }

  recent(): PushBatch[] {
    return this.batches.map((b) => ({ ...b, failureCodes: [...b.failureCodes] }));
  }
}
