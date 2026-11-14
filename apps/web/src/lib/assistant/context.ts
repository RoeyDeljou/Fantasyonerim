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

/** The launcher's FPL Lad logo (a wordmark; swap for a square Alfie icon here if FPL Lad provides one). */
export const FPL_LAD_LOGO = '/brand/fpl-lad.png';

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

/**
 * FPL Lad's site with our context as query parameters: `partner`, `locale`, `theme`, `teamId` (when known) and,
 * for the in-app iframe, `embed=1`. Parameters already on `base` are kept (ours win on a clash).
 */
export function assistantUrl(base: string, ctx: AssistantContext, { embed }: { embed: boolean }): string {
  const url = new URL(base);
  url.searchParams.set('partner', ctx.partner);
  if (embed) url.searchParams.set('embed', '1');
  else url.searchParams.delete('embed');
  url.searchParams.set('locale', ctx.locale);
  url.searchParams.set('theme', ctx.theme);
  if (ctx.teamId !== undefined) url.searchParams.set('teamId', String(ctx.teamId));
  else url.searchParams.delete('teamId');
  return url.toString();
}
