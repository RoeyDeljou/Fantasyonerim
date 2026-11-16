import type { AssistantConfig, FplEntryId, Role } from '@fant/shared';

/** The signed-in viewer as far as the launcher cares; null/undefined = a guest (or `me` still loading). */
export interface AssistantViewer {
  role: Role;
  entryId: FplEntryId | null;
}

/**
 * Who sees the "Ask Alfie" launcher (FPL Lad's AI assistant): `everyone` = every fan and guest, `admins` = a
 * signed-in admin or a signed-in tester (a fan whose FPL Team ID is in `testerEntryIds`, to try it with a real
 * registered team before launch), `off` / no config (an older API) = nobody. Guests are never testers. Returns the
 * config when the launcher shows, else null. Imported by the tab shell, so it stays tiny.
 */
export function assistantFor(
  config: AssistantConfig | null | undefined,
  viewer: AssistantViewer | null | undefined,
): AssistantConfig | null {
  if (!config) return null;
  if (config.visibility === 'everyone') return config;
  if (config.visibility !== 'admins' || !viewer) return null;
  if (viewer.role === 'admin') return config;
  const { entryId } = viewer;
  return entryId !== null && config.testerEntryIds.includes(entryId) ? config : null;
}
