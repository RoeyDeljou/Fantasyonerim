'use client';

import { useMemo, useState } from 'react';
import type { FplPlayerId } from '@fant/shared';
import { useI18n } from '@/i18n';
import type { FplIndex } from '@/lib/queries';
import { normalizeName } from '@/lib/captainVote';
import { BottomSheet } from '@/components/BottomSheet';
import { ImageWithFallback, fplImage } from '@/components/FplImages';
import { Badge, TextField } from '@/components/ui';

/** Search-and-pick sheet over every FPL player (admin: battle rows, the community-captain tie-break). */
export function PlayerPicker({
  open,
  index,
  onClose,
  onPick,
}: {
  open: boolean;
  index: FplIndex;
  onClose(): void;
  onPick(id: FplPlayerId): void;
}) {
  const { t, f } = useI18n();
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const needle = normalizeName(q.trim());
    const all = index.bootstrap.players;
    const list = needle
      ? all.filter((p) => normalizeName(`${p.webName} ${p.firstName} ${p.secondName}`).includes(needle))
      : [...all].sort((a, b) => b.selectedByPercent - a.selectedByPercent);
    return list.slice(0, 40);
  }, [q, index]);

  return (
    <BottomSheet open={open} onClose={onClose} title={t.admin.pickPlayer}>
      <div className="sticky top-0 z-10 bg-surface pb-2">
        <TextField
          label={t.admin.searchPlayers}
          type="search"
          autoFocus
          dir="ltr"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {results.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">{t.admin.noPlayers}</p>
      ) : (
        <ul className="divide-y divide-line">
          {results.map((p) => {
            const team = index.teams.get(p.teamId);
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onPick(p.id)}
                  className="flex min-h-14 w-full items-center gap-3 py-2 text-start hover:bg-surface-2"
                >
                  <ImageWithFallback
                    src={fplImage.photo(p.photoCode)}
                    name={p.webName}
                    className="h-11 w-9 shrink-0 rounded-md bg-surface-2 object-cover object-top"
                    fallbackClassName="size-9 text-xs"
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span dir="auto" className="name-start truncate font-semibold text-ink">
                      {p.webName}
                    </span>
                    <span className="truncate text-xs text-muted">
                      {p.firstName} {p.secondName}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-0.5">
                    <Badge>{team?.shortName ?? '?'}</Badge>
                    <span className="text-xs text-muted">
                      {t.positions[p.position]} · {f.price(p.nowCost)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </BottomSheet>
  );
}
