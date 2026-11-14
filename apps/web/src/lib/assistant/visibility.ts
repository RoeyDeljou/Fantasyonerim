import type { AssistantConfig, Role } from '@fant/shared';

/**
 * Who sees the "Ask Alfie" launcher (FPL Lad's AI assistant): `everyone` = every fan and guest, `admins` = only a
 * signed-in admin (to try it before launch), `off` / no config (an older API) = nobody. Returns the config when
 * the launcher shows, else null. Imported by the tab shell, so it stays tiny.
 */
export function assistantFor(
  config: AssistantConfig | null | undefined,
  role: Role | null | undefined,
): AssistantConfig | null {
  if (!config) return null;
  if (config.visibility === 'everyone') return config;
  return config.visibility === 'admins' && role === 'admin' ? config : null;
}
