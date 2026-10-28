import {
  AdminSettingsSchema,
  CaptainBattleConfigSchema,
  PublicConfigSchema,
  type AdminSettings,
  type CaptainBattleConfig,
  type PublicConfig,
} from '@fant/shared';
import { serialize } from './validate.js';
import type { AppSettings, CaptainBattle, CaptainBattleEntry, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { EXPECTED_INSTAGRAM_USERNAME, INTEGRATIONS } from './integrations/config.js';

const SETTINGS_ID = 1;

export async function getSettings(prisma: PrismaClient): Promise<AppSettings> {
  return prisma.appSettings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } });
}

export type Socials = AdminSettings['socials'];

const NO_SOCIALS: Socials = {
  spotifyUrl: null,
  appleUrl: null,
  instagramUrl: null,
  xUrl: null,
  whatsappUrl: null,
};
const StringRecordSchema = z.record(z.string(), z.string());
const SPOTIFY_SHOW_ID = /^[A-Za-z0-9]{22}$/;
const APPLE_PODCAST_ID = /^\d{1,15}$/;
const INSTAGRAM_USERNAME = /^[A-Za-z0-9._]{1,30}$/;

/**
 * Social links derived from the configured integrations, used wherever the admin hasn't stored one:
 * Spotify show + Apple podcast from their (enabled) integrations, Instagram from the connected account's
 * username or else the client-confirmed account. X and WhatsApp have no confirmed default → null.
 * Reads only the non-secret settings JSON (no decryption). A missing row uses the integration's defaults.
 */
export async function derivedSocials(prisma: PrismaClient): Promise<Socials> {
  const rows = await prisma.integrationConfig.findMany({
    where: { id: { in: ['spotify', 'apple', 'instagram'] } },
    select: { id: true, enabled: true, settings: true },
  });
  const read = (id: 'spotify' | 'apple' | 'instagram') => {
    const row = rows.find((r) => r.id === id);
    if (row === undefined) {
      return { enabled: INTEGRATIONS[id].defaultEnabled, settings: { ...INTEGRATIONS[id].defaultSettings } };
    }
    const parsed = StringRecordSchema.safeParse(row.settings);
    return { enabled: row.enabled, settings: parsed.success ? parsed.data : {} };
  };
  const spotify = read('spotify');
  const apple = read('apple');
  const instagram = read('instagram');
  const showId = spotify.settings['showId'] ?? '';
  const podcastId = apple.settings['podcastId'] ?? '';
  const igUser = instagram.settings['username'] ?? '';
  // Instagram is disabled until "Connect" — the confirmed account is the default until then.
  const username =
    instagram.enabled && INSTAGRAM_USERNAME.test(igUser) ? igUser : EXPECTED_INSTAGRAM_USERNAME;
  return {
    ...NO_SOCIALS,
    spotifyUrl:
      spotify.enabled && SPOTIFY_SHOW_ID.test(showId) ? `https://open.spotify.com/show/${showId}` : null,
    appleUrl:
      apple.enabled && APPLE_PODCAST_ID.test(podcastId)
        ? `https://podcasts.apple.com/podcast/id${podcastId}`
        : null,
    instagramUrl: `https://www.instagram.com/${username}/`,
  };
}

/**
 * Effective socials: the stored value when set, else the derived default. Saving persists exactly what the admin
 * submitted; a field the admin clears (null) therefore shows the derived default again on the next load — accepted:
 * there is no "deliberately no link" state for Spotify/Apple/Instagram.
 */
function socialsOf(s: AppSettings, defaults: Socials): Socials {
  return {
    spotifyUrl: s.spotifyUrl ?? defaults.spotifyUrl,
    appleUrl: s.appleUrl ?? defaults.appleUrl,
    instagramUrl: s.instagramUrl ?? defaults.instagramUrl,
    xUrl: s.xUrl ?? defaults.xUrl,
    whatsappUrl: s.whatsappUrl ?? defaults.whatsappUrl,
  };
}

export function toAdminSettings(s: AppSettings, defaults: Socials = NO_SOCIALS): AdminSettings {
  return serialize(
    AdminSettingsSchema,
    {
      leagueId: s.leagueId,
      leagueName: s.leagueName,
      deadlineReminderMinutes: s.deadlineReminderMinutes,
      socials: socialsOf(s, defaults),
    },
    'settings',
  );
}

export type BattleWithEntries = CaptainBattle & { entries: CaptainBattleEntry[] };

/** The battle shown publicly is the most recently saved one. */
export function getLatestBattle(prisma: PrismaClient): Promise<BattleWithEntries | null> {
  return prisma.captainBattle.findFirst({
    orderBy: { updatedAt: 'desc' },
    include: { entries: { orderBy: { order: 'asc' } } },
  });
}

export function toBattleConfig(battle: BattleWithEntries): CaptainBattleConfig {
  return serialize(
    CaptainBattleConfigSchema,
    {
      event: battle.event,
      entries: battle.entries.map((e) => ({
        label: e.label,
        kind: e.kind === 'COMMUNITY' ? 'community' : 'custom',
        ...(e.source === 'ENTRY'
          ? { source: 'entry', entryId: e.entryId }
          : { source: 'player', playerId: e.playerId }),
      })),
    },
    'settings',
  );
}

export function toPublicConfig(
  s: AppSettings,
  battle: CaptainBattle | null,
  defaults: Socials = NO_SOCIALS,
): PublicConfig {
  return serialize(
    PublicConfigSchema,
    {
      league: s.leagueId === null ? null : { id: s.leagueId, name: s.leagueName },
      captainBattleEvent: battle?.event ?? null,
      socials: socialsOf(s, defaults),
    },
    'settings',
  );
}
