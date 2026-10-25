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

const SETTINGS_ID = 1;

export async function getSettings(prisma: PrismaClient): Promise<AppSettings> {
  return prisma.appSettings.upsert({ where: { id: SETTINGS_ID }, update: {}, create: { id: SETTINGS_ID } });
}

function socialsOf(s: AppSettings): AdminSettings['socials'] {
  return {
    spotifyUrl: s.spotifyUrl,
    appleUrl: s.appleUrl,
    instagramUrl: s.instagramUrl,
    xUrl: s.xUrl,
    whatsappUrl: s.whatsappUrl,
  };
}

export function toAdminSettings(s: AppSettings): AdminSettings {
  return serialize(
    AdminSettingsSchema,
    {
      leagueId: s.leagueId,
      leagueName: s.leagueName,
      deadlineReminderMinutes: s.deadlineReminderMinutes,
      socials: socialsOf(s),
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
        playerId: e.playerId,
        kind: e.kind === 'COMMUNITY' ? 'community' : 'custom',
      })),
    },
    'settings',
  );
}

export function toPublicConfig(s: AppSettings, battle: CaptainBattle | null): PublicConfig {
  return serialize(
    PublicConfigSchema,
    {
      league: s.leagueId === null ? null : { id: s.leagueId, name: s.leagueName },
      captainBattleEvent: battle?.event ?? null,
      socials: socialsOf(s),
    },
    'settings',
  );
}
