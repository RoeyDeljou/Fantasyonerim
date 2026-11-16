import type { Locale } from '@fant/shared';

/**
 * What the app tells FPL Lad's assistant ("Alfie") about the visitor, both through their embed script
 * (lib/assistant/fplLad.ts) and as query parameters on the in-app panel's URL (components/assistant/AlfiePanel.tsx).
 * Pure: unit-tested in context.test.ts.
 */
export interface AssistantContext {
  /** Our partner key with FPL Lad (`config.partnerId`, else DEFAULT_PARTNER). */
  partner: string;
  /** The visitor's FPL Team ID when we know it (account, or what a guest typed during sign-up). */
  teamId: number | undefined;
  locale: Locale;
  theme: 'light' | 'dark';
}

/** Sent until FPL Lad assigns us a partner id (Admin → Settings → Ask Alfie). */
export const DEFAULT_PARTNER = 'fantasyonerim';

/** FPL Lad's round badge (512×512 transparent PNG; the badge is the circle) for the launcher and panel header. */
export const FPL_LAD_LOGO = '/brand/fpl-lad-badge.png';

export function partnerOf(partnerId: string | null | undefined): string {
  const p = partnerId?.trim();
  return p ? p : DEFAULT_PARTNER;
}

/**
 * The Team ID to pass: the account's entry, else a guest's sign-up draft (digits only, as typed). FPL Team IDs are
 * positive integers; anything else is dropped.
 */
export function resolveTeamId(
  entryId: number | null | undefined,
  draftTeamId: string | null | undefined,
): number | undefined {
  if (typeof entryId === 'number' && Number.isSafeInteger(entryId) && entryId > 0) return entryId;
  const digits = draftTeamId?.trim() ?? '';
  if (!/^\d{1,10}$/.test(digits)) return undefined;
  const n = Number(digits);
  return n > 0 && Number.isSafeInteger(n) ? n : undefined;
}

/** The query parameters we own on FPL Lad's URL, in the order their example uses. */
const OWN_PARAMS = ['teamId', 'lang', 'embed', 'partner', 'theme', 'locale'] as const;

/**
 * FPL Lad's chat (`/chat`) with our context as query parameters, in the order FPL Lad's example uses:
 * `teamId` (when known), `lang` (he/en), `embed=1` (in-app iframe only), `partner`, `theme` — e.g.
 * `https://www.fpl-lad.com/chat?teamId=28060&lang=he&embed=1&partner=fantasyonerim&theme=light`. Parameters already
 * on `base` are kept, before ours (ours win on a clash; a stale `locale` from older configs is dropped).
 */
export function assistantUrl(base: string, ctx: AssistantContext, { embed }: { embed: boolean }): string {
  const url = new URL(base);
  for (const k of OWN_PARAMS) url.searchParams.delete(k);
  if (ctx.teamId !== undefined) url.searchParams.append('teamId', String(ctx.teamId));
  url.searchParams.append('lang', ctx.locale);
  if (embed) url.searchParams.append('embed', '1');
  url.searchParams.append('partner', ctx.partner);
  url.searchParams.append('theme', ctx.theme);
  return url.toString();
}
