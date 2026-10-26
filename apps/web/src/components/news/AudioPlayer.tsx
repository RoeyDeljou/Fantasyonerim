'use client';

import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { fmt, useI18n } from '@/i18n';
import { seek, seekBy, setRate, toggleEpisode, usePlayer } from '@/lib/audioPlayer';
import type { Episode } from '@/lib/audioPlayer';
import { PLAYBACK_RATES, readAudioPosition } from '@/lib/localState';
import { formatDuration } from '@/lib/newsFormat';
import { ForwardIcon, PauseIcon, PlayIcon, RewindIcon } from '@/components/icons';
import { Spinner, cx } from '@/components/ui';

function rateLabel(r: number): string {
  return `${r}×`;
}

/**
 * Inline episode player. Playback lives in the app-wide audio element (lib/audioPlayer), so only one episode
 * plays at a time and it keeps playing while the user scrolls. Media controls are laid out left-to-right in
 * both languages (time runs left → right on every platform's player), but labels are localized.
 */
export function AudioPlayer({ episode }: { episode: Episode }) {
  const { t } = useI18n();
  const player = usePlayer();
  const active = player.id === episode.id;
  // Not loaded yet: show the remembered position so the user sees where they stopped.
  const saved = useMemo(() => (active ? 0 : readAudioPosition(episode.id)), [active, episode.id]);
  const current = active ? player.current : saved;
  const duration = (active && player.duration) || episode.durationSec || 0;
  const pct = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;
  const playing = active && player.playing;
  const loading = active && player.loading && player.playing;

  const nextRate = () => {
    const i = PLAYBACK_RATES.indexOf(player.rate);
    setRate(PLAYBACK_RATES[(i + 1) % PLAYBACK_RATES.length] ?? 1);
  };

  return (
    <div className="flex flex-col gap-1 rounded-2xl bg-surface-2 p-2.5" data-testid="audio-player">
      <div dir="ltr" className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => toggleEpisode(episode)}
          aria-label={playing ? t.audio.pause : t.audio.play}
          aria-pressed={playing}
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary shadow-card transition-transform active:scale-95"
        >
          {loading ? <Spinner /> : playing ? <PauseIcon size={22} /> : <PlayIcon size={22} />}
        </button>
        <button
          type="button"
          disabled={!active}
          onClick={() => seekBy(-15)}
          aria-label={t.audio.back15}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-surface-3 disabled:opacity-40"
        >
          <RewindIcon size={26} strokeWidth={1.6} />
          <span className="absolute text-[9px] font-bold tabular">15</span>
        </button>
        <div className="flex min-w-0 flex-1 flex-col">
          <input
            type="range"
            className="scrubber w-full"
            min={0}
            max={Math.max(1, Math.round(duration))}
            step={1}
            value={Math.round(current)}
            disabled={!active}
            aria-label={t.audio.seek}
            aria-valuetext={`${formatDuration(current)} / ${formatDuration(duration)}`}
            style={{ '--p': `${pct}%` } as CSSProperties}
            onChange={(e) => seek(Number(e.target.value))}
          />
          <div className="flex justify-between text-[11px] font-medium text-muted tabular">
            <span>{formatDuration(current)}</span>
            <span>{duration > 0 ? formatDuration(duration) : '--:--'}</span>
          </div>
        </div>
        <button
          type="button"
          disabled={!active}
          onClick={() => seekBy(30)}
          aria-label={t.audio.fwd30}
          className="relative flex size-11 shrink-0 items-center justify-center rounded-full text-ink hover:bg-surface-3 disabled:opacity-40"
        >
          <ForwardIcon size={26} strokeWidth={1.6} />
          <span className="absolute text-[9px] font-bold tabular">30</span>
        </button>
        <button
          type="button"
          onClick={nextRate}
          aria-label={fmt(t.audio.speed, { rate: rateLabel(player.rate) })}
          className={cx(
            'flex h-11 min-w-12 shrink-0 items-center justify-center rounded-full px-2 text-sm font-bold tabular',
            player.rate === 1 ? 'text-muted hover:bg-surface-3' : 'bg-primary-soft text-on-primary-soft',
          )}
        >
          {rateLabel(player.rate)}
        </button>
      </div>
      {!active && saved > 0 && (
        <p className="px-1 text-xs text-muted">
          {fmt(t.audio.resume, { time: '' })}
          <bdi dir="ltr" className="tabular">
            {formatDuration(saved)}
          </bdi>
        </p>
      )}
      {active && player.error && (
        <p role="alert" className="px-1 text-xs font-medium text-live">
          {t.audio.error}
        </p>
      )}
    </div>
  );
}
