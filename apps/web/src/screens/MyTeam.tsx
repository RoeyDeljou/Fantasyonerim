'use client';

import { Suspense, useMemo, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { GameweekSchema } from '@fant/shared';
import type { FplEntryId, FplPlayerId, Gameweek, LivePick, Pick } from '@fant/shared';
import { useI18n } from '@/i18n';
import { isApiError } from '@/lib/api';
import {
  useEntry,
  useEntryLive,
  useFixtures,
  useFplIndex,
  useLivePollInterval,
  useMe,
  usePicks,
} from '@/lib/queries';
import type { FplIndex } from '@/lib/queries';
import { AppShell, ShellSkeleton } from '@/components/AppShell';
import { ShirtIcon } from '@/components/icons';
import { Pitch } from '@/components/team/Pitch';
import { PlayerSheet } from '@/components/team/PlayerSheet';
import {
  ChipsPanel,
  GwSelector,
  TeamHeader,
  TeamHeaderSkeleton,
  pitchLabel,
} from '@/components/team/TeamParts';
import { LiveTeamView } from '@/components/team/LiveTeamView';
import { EmptyState, ErrorState, Segmented, Skeleton } from '@/components/ui';

type View = 'team' | 'live';

export function MyTeamScreen() {
  const { t } = useI18n();
  return (
    <AppShell title={t.myTeam.title}>
      <Suspense fallback={<ShellSkeleton />}>
        <MyTeamInner />
      </Suspense>
    </AppShell>
  );
}

function MyTeamInner() {
  const { t } = useI18n();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const view: View = params.get('view') === 'live' ? 'live' : 'team';
  const gwParam = GameweekSchema.safeParse(params.get('gw') ?? undefined);
  const me = useMe();
  const fpl = useFplIndex();

  const setParams = (next: { view?: View; gw?: Gameweek | null }) => {
    const sp = new URLSearchParams(params.toString());
    const v = next.view ?? view;
    if (v === 'live') sp.set('view', 'live');
    else sp.delete('view');
    if (next.gw !== undefined) {
      if (next.gw === null) sp.delete('gw');
      else sp.set('gw', String(next.gw));
    }
    const qs = sp.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };

  const segmented = (
    <Segmented<View>
      label={t.myTeam.viewsLabel}
      value={view}
      onChange={(v) => setParams({ view: v })}
      options={[
        { value: 'team', label: t.myTeam.viewTeam },
        { value: 'live', label: t.myTeam.viewLive },
      ]}
    />
  );

  if (me.isPending || fpl.isPending) {
    return (
      <div className="flex flex-col gap-3">
        {segmented}
        <TeamHeaderSkeleton />
        <Skeleton className="h-[28rem]" />
      </div>
    );
  }
  if (me.isError) return <ErrorState error={me.error} onRetry={() => me.refetch()} />;
  if (fpl.isError || !fpl.index) return <ErrorState error={fpl.error} onRetry={() => fpl.refetch()} />;

  const entryId = me.data.entryId;
  if (entryId === null) {
    return <EmptyState icon={<ShirtIcon width={32} height={32} />} title={t.myTeam.noEntry} />;
  }
  const current = fpl.index.bootstrap.currentEvent;
  if (current === null) {
    return (
      <div className="flex flex-col gap-3">
        {segmented}
        <EmptyState icon={<ShirtIcon width={32} height={32} />} title={t.myTeam.seasonNotStarted} />
      </div>
    );
  }
  const gw = gwParam.success && gwParam.data <= current ? gwParam.data : current;

  return (
    <div className="flex flex-col gap-3">
      {segmented}
      {view === 'team' ? (
        <TeamView
          entryId={entryId}
          gw={gw}
          current={current}
          index={fpl.index}
          onGw={(g) => setParams({ gw: g === current ? null : g })}
        />
      ) : (
        <LiveTeamView entryId={entryId} event={current} index={fpl.index} />
      )}
    </div>
  );
}

function TeamView({
  entryId,
  gw,
  current,
  index,
  onGw,
}: {
  entryId: FplEntryId;
  gw: Gameweek;
  current: Gameweek;
  index: FplIndex;
  onGw(gw: Gameweek): void;
}) {
  const { t } = useI18n();
  const { interval } = useLivePollInterval();
  const entry = useEntry(entryId);
  const picks = usePicks(entryId, gw);
  const live = useEntryLive(entryId, gw, gw === current ? interval : false);
  const fixtures = useFixtures(gw);
  const [selected, setSelected] = useState<Pick | null>(null);

  const liveByPlayer = useMemo(
    () =>
      live.data ? new Map<FplPlayerId, LivePick>(live.data.picks.map((p) => [p.playerId, p])) : undefined,
    [live.data],
  );

  return (
    <>
      {picks.isPending ? (
        <TeamHeaderSkeleton />
      ) : picks.isError ? null : (
        <TeamHeader entry={entry.data} picks={picks.data} />
      )}
      <GwSelector value={gw} max={current} onChange={onGw} />
      {picks.isPending && <Skeleton className="h-[28rem]" />}
      {picks.isError &&
        (isApiError(picks.error, 'not_found') ? (
          <EmptyState icon={<ShirtIcon width={32} height={32} />} title={t.myTeam.noData} />
        ) : (
          <ErrorState error={picks.error} onRetry={() => picks.refetch()} />
        ))}
      {picks.data && (
        <>
          <Pitch
            picks={picks.data.picks}
            index={index}
            onSelect={setSelected}
            renderLabel={(p, player) => pitchLabel(p, player, liveByPlayer, fixtures.data, index, t)}
          />
          <ChipsPanel picks={picks.data} />
        </>
      )}
      <PlayerSheet
        pick={selected}
        livePick={selected ? liveByPlayer?.get(selected.playerId) : undefined}
        index={index}
        fixtures={fixtures.data}
        onClose={() => setSelected(null)}
      />
    </>
  );
}
