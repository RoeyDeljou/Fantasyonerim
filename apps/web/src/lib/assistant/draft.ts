import { AssistantConfigSchema, FplEntryIdSchema, HttpsUrlSchema } from '@fant/shared';
import type { AssistantConfig, AssistantVisibility, FplEntryId } from '@fant/shared';

/** Admin → Settings → "Ask Alfie": the form's text fields ⇄ an `AssistantConfig` (screens/admin/AssistantCard.tsx). */
export type AssistantField = 'scriptUrl' | 'partnerId' | 'fallbackUrl';
export type AssistantDraft = {
  visibility: AssistantVisibility;
  testerEntryIds: readonly FplEntryId[];
} & Record<AssistantField, string>;

/** At most this many testers (the shared schema's own cap). */
export const MAX_ASSISTANT_TESTERS = 50;

export function draftOf(c: AssistantConfig): AssistantDraft {
  return {
    visibility: c.visibility,
    scriptUrl: c.scriptUrl ?? '',
    partnerId: c.partnerId ?? '',
    fallbackUrl: c.fallbackUrl,
    testerEntryIds: c.testerEntryIds,
  };
}

export type AddTesterResult =
  { ok: true; list: FplEntryId[] } | { ok: false; error: 'invalid' | 'duplicate' | 'full' };

/** The "Testers" input → the list with one more FPL Team ID (a positive integer, no duplicates, at most 50). */
export function addTester(list: readonly FplEntryId[], input: string): AddTesterResult {
  const raw = input.trim();
  if (!/^\d+$/.test(raw)) return { ok: false, error: 'invalid' };
  const parsed = FplEntryIdSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: 'invalid' };
  if (list.includes(parsed.data)) return { ok: false, error: 'duplicate' };
  if (list.length >= MAX_ASSISTANT_TESTERS) return { ok: false, error: 'full' };
  return { ok: true, list: [...list, parsed.data] };
}

/** The form → a config, validated with the shared schema (the API's own rule), or the fields in error. */
export function parseAssistantDraft(
  d: AssistantDraft,
): { ok: true; config: AssistantConfig } | { ok: false; errors: Partial<Record<AssistantField, true>> } {
  const errors: Partial<Record<AssistantField, true>> = {};
  const scriptUrl = d.scriptUrl.trim();
  const partnerId = d.partnerId.trim();
  const fallbackUrl = d.fallbackUrl.trim();
  const shape = AssistantConfigSchema.shape;
  const script = shape.scriptUrl.safeParse(scriptUrl === '' ? null : scriptUrl);
  if (!script.success) errors.scriptUrl = true;
  const partner = shape.partnerId.safeParse(partnerId === '' ? null : partnerId);
  if (!partner.success) errors.partnerId = true;
  const fallback = HttpsUrlSchema.safeParse(fallbackUrl);
  if (!fallback.success) errors.fallbackUrl = true;
  if (!script.success || !partner.success || !fallback.success) return { ok: false, errors };
  const parsed = AssistantConfigSchema.safeParse({
    visibility: d.visibility,
    scriptUrl: script.data,
    partnerId: partner.data,
    fallbackUrl: fallback.data,
    testerEntryIds: [...d.testerEntryIds],
  });
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, errors: { fallbackUrl: true } };
}
