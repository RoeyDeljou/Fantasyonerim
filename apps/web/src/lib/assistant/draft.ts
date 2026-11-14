import { AssistantConfigSchema, HttpsUrlSchema } from '@fant/shared';
import type { AssistantConfig, AssistantVisibility } from '@fant/shared';

/** Admin → Settings → "Ask Alfie": the form's text fields ⇄ an `AssistantConfig` (screens/admin/AssistantCard.tsx). */
export type AssistantField = 'scriptUrl' | 'partnerId' | 'fallbackUrl';
export type AssistantDraft = { visibility: AssistantVisibility } & Record<AssistantField, string>;

export function draftOf(c: AssistantConfig): AssistantDraft {
  return {
    visibility: c.visibility,
    scriptUrl: c.scriptUrl ?? '',
    partnerId: c.partnerId ?? '',
    fallbackUrl: c.fallbackUrl,
  };
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
  });
  return parsed.success ? { ok: true, config: parsed.data } : { ok: false, errors: { fallbackUrl: true } };
}
