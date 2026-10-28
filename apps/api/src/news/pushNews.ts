import { NewsSourceSchema, type NewsSource, type PushPayload } from '@fant/shared';
import { mapMediaUrl, type MediaUrlMapper } from '../media/publicUrl.js';
import { newsCopy } from '../push/copy.js';
import { notify, type NotifyDeps, type NotifyResult } from '../push/notify.js';
import type { NewsItemWithMedia } from './serialize.js';

/** Items published longer ago than this are imported silently (catch-up after downtime). */
export const NEWS_PUSH_MAX_AGE_MS = 12 * 60 * 60 * 1000;
export const NEWS_PUSH_TTL_SEC = 24 * 60 * 60;
export const PUSH_ICON = '/icons/icon-192.png';

function imageOf(item: NewsItemWithMedia, mediaUrl: MediaUrlMapper): string | null {
  const first = [...item.media].sort((a, b) => a.order - b.order)[0];
  if (first === undefined) return null;
  return mapMediaUrl(mediaUrl, first.kind === 'image' ? first.url : first.posterUrl);
}

/**
 * One push per source for the given freshly inserted items (several new stories → one "3 new stories"
 * notification), to users with the `news` preference on. Each item is claimed per user in
 * NotificationLog (`news:<itemId>`), so it is never announced twice.
 */
export async function pushNewNewsItems(
  deps: NotifyDeps & { mediaUrl: MediaUrlMapper },
  items: readonly NewsItemWithMedia[],
): Promise<NotifyResult> {
  const now = deps.clock.now().getTime();
  const fresh = items.filter(
    (i) => now - i.publishedAt.getTime() <= NEWS_PUSH_MAX_AGE_MS && i.hiddenAt === null,
  );
  const bySource = new Map<NewsSource, NewsItemWithMedia[]>();
  for (const item of fresh) {
    const source = NewsSourceSchema.safeParse(item.source);
    if (!source.success) continue;
    bySource.set(source.data, [...(bySource.get(source.data) ?? []), item]);
  }
  const total: NotifyResult = {
    recipients: 0,
    delivered: 0,
    devices: 0,
    devicesDelivered: 0,
    gone: 0,
    failed: 0,
    failureCodes: [],
  };
  for (const [source, group] of bySource) {
    group.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime());
    const newest = group[0];
    if (newest === undefined) continue;
    const result = await notify(deps, {
      kind: 'news',
      to: 'all',
      pref: 'news',
      dedupeKeys: group.map((i) => `news:${i.id}`),
      // 'high': iOS/Android may hold back 'normal' pushes (Low Power, Doze) — news should show promptly.
      options: { ttlSec: NEWS_PUSH_TTL_SEC, urgency: 'high' },
      build: ({ locale }): PushPayload => {
        const text = newsCopy(locale, source, group);
        return {
          title: text.title,
          body: text.body,
          url: `/news/?item=${encodeURIComponent(newest.id)}`,
          // Unique per batch: the service worker only sets `renotify` for deadline tags, so a reused tag
          // ("news-podcast") would silently replace a still-visible notification — no banner, no sound.
          tag: `news-${source}-${newest.id}`,
          icon: PUSH_ICON,
          image: group.map((i) => imageOf(i, deps.mediaUrl)).find((u) => u !== null) ?? null,
        };
      },
    });
    total.recipients += result.recipients;
    total.delivered += result.delivered;
    total.devices += result.devices;
    total.devicesDelivered += result.devicesDelivered;
    total.gone += result.gone;
    total.failed += result.failed;
    total.failureCodes = [...new Set([...total.failureCodes, ...result.failureCodes])].sort((a, b) => a - b);
  }
  return total;
}
