'use client';

import { useMemo } from 'react';
import type { FplEntryId, FplPlayerId, Gameweek, LivePick } from '@fant/shared';
import { fmt, useI18n } from '@/i18n';
import { isApiError } from '@/lib/api';
import { useEntry, useEntryLive, useFixtures, usePicks } from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { BottomSheet } from '../BottomSheet';
import { EmptyState, ErrorState, Skeleton } from '../ui';
import { Pitch } from './Pitch';
import { TeamHeader, pitchLabel } from './TeamParts';

/** Read-only view of another manager's team for the current GW (Table / Live Action rows). */
export function ManagerSheet({
  entryId,
  title,
  event,
  index,
  liveInterval,
  onClose,
}: {
  entryId: FplEntryId | null;
  title: string;
  event: Gameweek | null;
  index: FplIndex | undefined;
  liveInterval: number | false;
  onClose(): void;
}) {
  const { t } = useI18n();
  return (
    <BottomSheet open={entryId !== null} onClose={onClose} title={fmt(t.table.managerTeam, { name: title })}>
      {entryId !== null && index && event !== null ? (
        <ManagerTeam entryId={entryId} event={event} index={index} liveInterval={liveInterval} />
      ) : (
        <EmptyState title={t.myTeam.seasonNotStarted} />
      )}
    </BottomSheet>
  );
}

function ManagerTeam({
  entryId,
  event,
  index,
  liveInterval,
}: {
  entryId: FplEntryId;
  event: Gameweek;
  index: FplIndex;
  liveInterval: number | false;
}) {
  const { t } = useI18n();
  const entry = useEntry(entryId);
  const picks = usePicks(entryId, event);
  const live = useEntryLive(entryId, event, liveInterval);
  const fixtures = useFixtures(event);
  const liveByPlayer = useMemo(
    () =>
      live.data ? new Map<FplPlayerId, LivePick>(live.data.picks.map((p) => [p.playerId, p])) : undefined,
    [live.data],
  );

  if (picks.isPending) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-busy="true">
        <Skeleton className="h-40" />
        <Skeleton className="h-96" />
      </div>
    );
  }
  if (picks.isError) {
    return isApiError(picks.error, 'not_found') ? (
      <EmptyState title={t.myTeam.noData} />
    ) : (
      <ErrorState error={picks.error} onRetry={() => picks.refetch()} />
    );
  }
  return (
    <div className="flex flex-col gap-3">
      <TeamHeader entry={entry.data} picks={picks.data} pointsOverride={live.data?.livePoints} />
      <Pitch
        picks={picks.data.picks}
        index={index}
        renderLabel={(p, player) => pitchLabel(p, player, liveByPlayer, fixtures.data, index, t)}
      />
    </div>
  );
}
