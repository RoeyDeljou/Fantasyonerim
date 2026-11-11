'use client';

import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import type { Player } from '@fant/shared';
import { useI18n } from '@/i18n';
import { captainVote } from '@/i18n/sections/captainVote';
import { useSection } from '@/i18n/section';
import type { FplIndex } from '@/lib/queries';
import { buildSearchIndex, searchPlayers } from '@/lib/captainVote';
import { ImageWithFallback, fplImage } from '../FplImages';
import { SearchIcon } from '../icons';
import { Button, cx } from '../ui';

/** Smallest the dropdown is allowed to get when the keyboard leaves little room. */
const MIN_LIST_PX = 176;

/**
 * Player search with name completion: a combobox (role=combobox + listbox/option, aria-activedescendant, ↑ ↓ Enter
 * Esc) over EVERY player of the FPL bootstrap. The list opens in the flow right under the field — inside the app's
 * inner scroller, never over it — and its height follows the visual viewport, so the on-screen keyboard doesn't hide
 * the results. Rows are 56 px+ touch targets.
 */
export function PlayerCombobox({
  index,
  describe,
  onPick,
  onCancel,
  autoFocus,
  event,
}: {
  index: FplIndex;
  /** The row's second and third line: "ARS · MID" and "vs MCI (away)". */
  describe(p: Player): { club: string; position: string; opponent: string };
  onPick(p: Player): void;
  /** Shown when the fan is changing a confirmed pick. */
  onCancel?: (() => void) | undefined;
  autoFocus: boolean;
  event: number;
}) {
  const s = useSection(captainVote);
  const { f } = useI18n();
  const uid = useId();
  const listId = `${uid}-list`;
  const optionId = (i: number) => `${uid}-opt-${i}`;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(autoFocus);
  const [active, setActive] = useState(0);
  const [maxHeight, setMaxHeight] = useState<number | null>(null);

  const searchIndex = useMemo(() => buildSearchIndex(index.bootstrap.players), [index.bootstrap.players]);
  const deferred = useDeferredValue(q);
  const results = useMemo(() => searchPlayers(searchIndex, deferred), [searchIndex, deferred]);
  const typed = q.trim() !== '';
  const showList = open && results.length > 0;
  const showEmpty = open && typed && deferred === q && results.length === 0;

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus]);

  // The list's height = the room left under the field in the VISUAL viewport (the keyboard shrinks it).
  useEffect(() => {
    if (!open) return;
    const vv = window.visualViewport;
    const measure = () => {
      const el = input.current;
      if (!el) return;
      const bottom = el.getBoundingClientRect().bottom;
      const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
      setMaxHeight(Math.max(MIN_LIST_PX, Math.floor(viewportBottom - bottom - 12)));
    };
    measure();
    vv?.addEventListener('resize', measure);
    vv?.addEventListener('scroll', measure);
    window.addEventListener('resize', measure);
    const scroller = root.current?.closest('[data-app-scroller]');
    scroller?.addEventListener('scroll', measure, { passive: true });
    return () => {
      vv?.removeEventListener('resize', measure);
      vv?.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
      scroller?.removeEventListener('scroll', measure);
    };
  }, [open, showList]);

  // Keep the highlighted row visible while arrowing through the list.
  useEffect(() => {
    if (!showList) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: 'nearest' });
  }, [active, showList]);

  function choose(p: Player) {
    setOpen(false);
    onPick(p);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((a) => (results.length ? (a + 1) % results.length : 0));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
        break;
      case 'Home':
        if (showList) {
          e.preventDefault();
          setActive(0);
        }
        break;
      case 'End':
        if (showList) {
          e.preventDefault();
          setActive(results.length - 1);
        }
        break;
      case 'Enter': {
        const p = results[active];
        if (showList && p) {
          e.preventDefault();
          choose(p);
        }
        break;
      }
      case 'Escape':
        if (open) {
          e.preventDefault();
          e.stopPropagation();
          setOpen(false);
        } else if (q) {
          e.preventDefault();
          setQ('');
        }
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  }

  return (
    <div
      ref={root}
      className="flex flex-col gap-2"
      data-testid="cv-search"
      onBlur={(e) => {
        if (!root.current?.contains(e.relatedTarget)) setOpen(false);
      }}
    >
      <label htmlFor={`${uid}-input`} className="text-base font-bold text-ink">
        {s.searchLabel}
      </label>
      <div className="relative">
        <SearchIcon
          size={20}
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 my-auto start-3 text-muted"
        />
        <input
          id={`${uid}-input`}
          ref={input}
          type="text"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-activedescendant={showList ? optionId(active) : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          dir="auto"
          value={q}
          placeholder={s.searchPlaceholder}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => {
            setOpen(true);
            // Bring the field to the top of the content area: the keyboard is about to take half the screen.
            window.setTimeout(
              () => input.current?.scrollIntoView({ block: 'start', behavior: 'smooth' }),
              120,
            );
          }}
          onKeyDown={onKeyDown}
          className="min-h-12 w-full rounded-xl border border-line bg-surface-2 ps-10 pe-3 text-start text-base text-ink placeholder:text-muted focus:border-primary focus:outline-none"
          data-testid="cv-input"
        />
      </div>
      <p className="text-sm text-muted">{s.searchHint.replace('{gw}', f.num(event))}</p>

      {showList && (
        // The mousedown guard keeps the field focused while a row is tapped (a blur would close the list first).
        <ul
          id={listId}
          role="listbox"
          aria-label={typed ? s.listLabel : s.popular}
          onMouseDown={(e) => e.preventDefault()}
          style={maxHeight === null ? undefined : { maxHeight }}
          className="overflow-y-auto overscroll-contain rounded-2xl border border-line bg-surface shadow-card"
          data-testid="cv-list"
        >
          {!typed && (
            <li role="presentation" className="px-3 pt-2 pb-1 text-xs font-bold text-muted">
              {s.popular}
            </li>
          )}
          {results.map((p, i) => {
            const d = describe(p);
            return (
              <li
                key={p.id}
                id={optionId(i)}
                role="option"
                aria-selected={i === active}
                data-testid="cv-option"
                data-player={p.id}
                onMouseMove={() => active !== i && setActive(i)}
                onClick={() => choose(p)}
                className={cx(
                  'flex min-h-14 cursor-pointer items-center gap-3 border-b border-line px-3 py-2 last:border-b-0',
                  i === active && 'bg-primary-soft',
                )}
              >
                <ImageWithFallback
                  src={fplImage.photo(p.photoCode)}
                  name={p.webName}
                  className="h-11 w-9 shrink-0 rounded-md bg-surface-2 object-cover object-top"
                  fallbackClassName="size-9 text-xs"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span
                    dir="auto"
                    className="name-start truncate text-base leading-tight font-semibold text-ink"
                  >
                    {p.webName}
                  </span>
                  <span className="truncate text-xs text-muted">
                    <bdi>{d.club}</bdi> · {d.position}
                  </span>
                  <span className="truncate text-xs font-semibold text-primary" data-testid="cv-opponent">
                    {d.opponent}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {showEmpty && (
        <p
          role="status"
          className="rounded-2xl border border-dashed border-line px-3 py-6 text-center text-sm text-muted"
        >
          {s.noResults}
        </p>
      )}
      {onCancel && (
        <Button variant="ghost" className="self-start" onClick={onCancel} data-testid="cv-cancel">
          {s.cancelChange}
        </Button>
      )}
    </div>
  );
}
