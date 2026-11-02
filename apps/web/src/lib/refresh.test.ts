import { describe, expect, it } from 'vitest';
import type { Query } from '@tanstack/react-query';
import { REFRESH_SCOPES, inScope } from './refresh';

const q = (queryKey: unknown[]) => ({ queryKey }) as unknown as Query;

describe('refresh scopes', () => {
  it('Live Action refreshes the live table, captain battle and fixtures — never bootstrap', () => {
    const live = inScope(REFRESH_SCOPES.live);
    expect(live(q(['league', 'live']))).toBe(true);
    expect(live(q(['captain-battle']))).toBe(true);
    expect(live(q(['fpl', 'fixtures', 9]))).toBe(true);
    expect(live(q(['fpl', 'fixture', 120]))).toBe(true);
    expect(live(q(['fpl', 'bootstrap']))).toBe(false);
    expect(live(q(['news', 'feed']))).toBe(false);
  });

  it('News refreshes only news queries; a prefix matches element by element', () => {
    const news = inScope(REFRESH_SCOPES.news);
    expect(news(q(['news', 'feed', 'shorts']))).toBe(true);
    expect(news(q(['news', 'stories']))).toBe(true);
    expect(news(q(['newsish']))).toBe(false);
    expect(news(q(['league', 'standings']))).toBe(false);
    expect(inScope([['fpl', 'fixture', 7]])(q(['fpl', 'fixture', 7]))).toBe(true);
    expect(inScope([['fpl', 'fixture', 7]])(q(['fpl', 'fixture', 8]))).toBe(false);
  });
});
