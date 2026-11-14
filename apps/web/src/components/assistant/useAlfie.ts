'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssistantConfig } from '@fant/shared';
import { useI18n } from '@/i18n';
import { useTheme } from '@/lib/theme';
import { useSession } from '@/lib/session';
import { useMe } from '@/lib/queries';
import { readSignUpDraft } from '@/lib/guest';
import { partnerOf, resolveTeamId } from '@/lib/assistant/context';
import type { AssistantContext } from '@/lib/assistant/context';
import { buildOptions, fplLad } from '@/lib/assistant/fplLad';
import type { FplLadOptions } from '@/lib/assistant/fplLad';
import { readVisitorToken, saveVisitorToken } from '@/lib/assistant/visitor';

/** Above the app's own toasts (z-50); our dialogs are in the top layer anyway. */
const WIDGET_Z = 60;

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** How far their widget should keep above the bottom edge: our tab bar + the dock above it (0 off the tabs). */
function bottomOffset(): number {
  const h = (sel: string) => document.querySelector(sel)?.getBoundingClientRect().height ?? 0;
  return Math.round(h('[data-tab-bar]') + h('[data-shell-dock]'));
}

function widgetOptions(ctx: AssistantContext): FplLadOptions {
  return buildOptions(ctx, {
    colors: { primary: cssVar('--primary'), onPrimary: cssVar('--on-primary'), surface: cssVar('--surface') },
    zIndex: WIDGET_Z,
    bottomOffset: bottomOffset(),
    visitorToken: readVisitorToken(),
  });
}

/**
 * Opening Alfie (FPL Lad's assistant) for a config: their widget through the embed adapter when a script is set,
 * else — or when the script fails — our in-app panel. Used by the launcher and by the admin's "Preview".
 */
export function useAlfie(config: AssistantConfig) {
  const { locale } = useI18n();
  const { resolved: theme } = useTheme();
  const { status } = useSession();
  const me = useMe(status === 'signedIn');
  const entryId = me.data?.entryId ?? null;
  const [draftTeamId] = useState(() => readSignUpDraft()?.teamId ?? null);
  // A guest's Team ID from the sign-up form they started (lib/guest.ts; cleared when they sign in).
  const teamId = resolveTeamId(entryId, draftTeamId);

  const ctx = useMemo<AssistantContext>(
    () => ({ partner: partnerOf(config.partnerId), teamId, locale, theme }),
    [config.partnerId, teamId, locale, theme],
  );

  const [panelOpen, setPanelOpen] = useState(false);
  const [widgetOpen, setWidgetOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const open = useCallback(async () => {
    if (busy) return;
    if (!config.scriptUrl) {
      setPanelOpen(true);
      return;
    }
    setBusy(true);
    try {
      const r = await fplLad().open(config.scriptUrl, partnerOf(config.partnerId), widgetOptions(ctx), {
        onClose: () => setWidgetOpen(false),
        onIdentity: saveVisitorToken,
      });
      if (r.kind === 'fallback') setPanelOpen(true);
      else if (r.tracksClose) setWidgetOpen(true);
    } finally {
      setBusy(false);
    }
  }, [busy, config.scriptUrl, config.partnerId, ctx]);

  /** Starts loading their script early (pointer down / hover on the launcher). */
  const warm = useCallback(() => {
    if (config.scriptUrl) void fplLad().load(config.scriptUrl, partnerOf(config.partnerId));
  }, [config.scriptUrl, config.partnerId]);

  // Signed in/out, language or theme changed: tell an initialized widget (no-op until then / without `update`).
  useEffect(() => {
    if (config.scriptUrl) fplLad().update(widgetOptions(ctx));
  }, [ctx, config.scriptUrl]);

  const closePanel = useCallback(() => setPanelOpen(false), []);

  return { open, warm, busy, panelOpen, widgetOpen, closePanel, ctx };
}
