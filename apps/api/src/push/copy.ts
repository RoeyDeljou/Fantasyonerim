import type { Locale, NewsSource } from '@fant/shared';

/**
 * Every server-sent notification string, Hebrew (default) + English. The web app's i18n dictionaries
 * cover the UI; push text is rendered by the OS, so it is localized here per recipient (User.locale).
 */

export interface PushText {
  title: string;
  body: string;
}

const BRAND: Record<Locale, string> = { he: 'פנטזיונרים', en: 'Fantasyonerim' };

export function snippet(text: string | null, max = 140): string {
  if (text === null) return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

export interface NewsCopyItem {
  title: string | null;
  text: string | null;
}

/** One notification for one or several new items from the same source. */
export function newsCopy(locale: Locale, source: NewsSource, items: readonly NewsCopyItem[]): PushText {
  const first = items[0] ?? { title: null, text: null };
  const n = items.length;
  const he = locale === 'he';
  if (n > 1) {
    const title = he
      ? {
          podcast: `🎙️ ${n} פרקים חדשים`,
          instagram_post: `📸 ${n} פוסטים חדשים באינסטגרם`,
          instagram_story: `${n} סטוריז חדשים מ${BRAND.he}`,
          x_post: `${n} פוסטים חדשים ב-X`,
          admin_update: `${n} עדכונים חדשים מ${BRAND.he}`,
        }[source]
      : {
          podcast: `🎙️ ${n} new episodes`,
          instagram_post: `📸 ${n} new Instagram posts`,
          instagram_story: `${n} new stories from ${BRAND.en}`,
          x_post: `${n} new posts on X`,
          admin_update: `${n} new updates from ${BRAND.en}`,
        }[source];
    const body = snippet(first.title ?? first.text) || (he ? 'פתחו את הפיד' : 'Open the feed');
    return { title, body };
  }
  switch (source) {
    case 'podcast':
      return {
        title: he ? `🎙️ פרק חדש: ${first.title ?? ''}`.trim() : `🎙️ New episode: ${first.title ?? ''}`.trim(),
        body: snippet(first.text) || (he ? 'האזינו עכשיו' : 'Listen now'),
      };
    case 'instagram_post':
      return {
        title: he ? '📸 פוסט חדש באינסטגרם' : '📸 New Instagram post',
        body: snippet(first.text) || BRAND[locale],
      };
    case 'instagram_story':
      return {
        title: he ? 'סטורי חדש' : 'New story',
        body: he ? `${BRAND.he} העלו סטורי חדש` : `${BRAND.en} posted a new story`,
      };
    case 'x_post':
      return { title: he ? 'פוסט חדש ב-X' : 'New post on X', body: snippet(first.text) || BRAND[locale] };
    case 'admin_update':
      return {
        title: first.title ?? (he ? `עדכון מ${BRAND.he}` : `Update from ${BRAND.en}`),
        body: snippet(first.text),
      };
  }
}

/** Max characters of a live broadcast shown in the notification body. */
export const BROADCAST_SNIPPET_CHARS = 180;

/** Admin live update (e.g. a goal alert): the headline (or the brand) + the start of the message. */
export function broadcastCopy(locale: Locale, title: string | null, text: string): PushText {
  return { title: title ?? BRAND[locale], body: snippet(text, BROADCAST_SNIPPET_CHARS) };
}

/** "שעתיים" / "2 hours", "יום" / "1 day", "30 דקות" / "30 minutes". */
export function formatOffset(locale: Locale, minutes: number): string {
  if (locale === 'he') {
    if (minutes % 1440 === 0) {
      const d = minutes / 1440;
      return d === 1 ? 'יום' : d === 2 ? 'יומיים' : `${d} ימים`;
    }
    if (minutes % 60 === 0) {
      const h = minutes / 60;
      return h === 1 ? 'שעה' : h === 2 ? 'שעתיים' : `${h} שעות`;
    }
    return minutes === 1 ? 'דקה' : `${minutes} דקות`;
  }
  const unit = (value: number, word: string) => `${value} ${word}${value === 1 ? '' : 's'}`;
  if (minutes % 1440 === 0) return unit(minutes / 1440, 'day');
  if (minutes % 60 === 0) return unit(minutes / 60, 'hour');
  return unit(minutes, 'minute');
}

export function deadlineCopy(locale: Locale, gameweek: number, offsetMinutes: number): PushText {
  const left = formatOffset(locale, offsetMinutes);
  return locale === 'he'
    ? { title: `⏰ הדדליין של מחזור ${gameweek} בעוד ${left}!`, body: 'זה הזמן לחילופים ולבחירת קפטן.' }
    : {
        title: `⏰ Gameweek ${gameweek} deadline in ${left}!`,
        body: 'Time to make your transfers and pick a captain.',
      };
}

const fmt = (n: number) => n.toLocaleString('en-US');

export function gameweekSummaryCopy(
  locale: Locale,
  gameweek: number,
  points: number,
  overallRank: number | null,
): PushText {
  if (locale === 'he') {
    const rank = overallRank === null ? '' : ` · דירוג ${fmt(overallRank)}`;
    return { title: `מחזור ${gameweek} הסתיים: ${points} נק'${rank}`, body: 'לחצו לפרטי הקבוצה שלכם' };
  }
  const rank = overallRank === null ? '' : ` · rank ${fmt(overallRank)}`;
  return { title: `Gameweek ${gameweek} is over: ${points} pts${rank}`, body: 'Tap to see your team' };
}

/** Max characters of the comment shown in the notification body. */
export const COMMENT_SNIPPET_CHARS = 60;

/** "💬 <name> commented on your post" + the start of the comment. */
export function commentCopy(locale: Locale, commenterName: string, text: string): PushText {
  return {
    title:
      locale === 'he' ? `💬 ${commenterName} הגיב/ה לפוסט שלך` : `💬 ${commenterName} commented on your post`,
    body: snippet(text, COMMENT_SNIPPET_CHARS),
  };
}
