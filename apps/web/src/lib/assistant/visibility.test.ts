import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSISTANT_CONFIG, FplEntryIdSchema } from '@fant/shared';
import type { AssistantConfig, FplEntryId, Role } from '@fant/shared';
import { assistantFor } from './visibility';

const id = (n: number): FplEntryId => FplEntryIdSchema.parse(n);
const cfg = (visibility: AssistantConfig['visibility'], testers: number[] = []): AssistantConfig => ({
  ...DEFAULT_ASSISTANT_CONFIG,
  visibility,
  testerEntryIds: testers.map(id),
});
const viewer = (role: Role, entryId: number | null = null) => ({
  role,
  entryId: entryId === null ? null : id(entryId),
});

describe('assistantFor (who sees "Ask Alfie")', () => {
  it('hidden without a config (older API) and when off — testers included', () => {
    expect(assistantFor(null, viewer('admin'))).toBeNull();
    expect(assistantFor(undefined, viewer('admin'))).toBeNull();
    expect(assistantFor(cfg('off'), viewer('admin'))).toBeNull();
    expect(assistantFor(cfg('off'), viewer('user'))).toBeNull();
    expect(assistantFor(cfg('off', [28060]), viewer('user', 28060))).toBeNull();
  });
  it('admins mode: a signed-in admin', () => {
    expect(assistantFor(cfg('admins'), viewer('admin'))).toEqual(cfg('admins'));
    expect(assistantFor(cfg('admins'), viewer('admin', 5))).toEqual(cfg('admins'));
    expect(assistantFor(cfg('admins'), viewer('user', 5))).toBeNull();
    expect(assistantFor(cfg('admins'), null)).toBeNull(); // guest
    expect(assistantFor(cfg('admins'), undefined)).toBeNull(); // me still loading
  });
  it('admins mode: a signed-in fan whose Team ID is a tester', () => {
    const c = cfg('admins', [28060, 77]);
    expect(assistantFor(c, viewer('user', 28060))).toEqual(c);
    expect(assistantFor(c, viewer('user', 77))).toEqual(c);
    expect(assistantFor(c, viewer('user', 78))).toBeNull();
    expect(assistantFor(c, viewer('user', null))).toBeNull();
    expect(assistantFor(c, null)).toBeNull(); // guests are never testers
  });
  it('admins mode with an explicitly empty tester list: admins only', () => {
    expect(assistantFor(cfg('admins', []), viewer('user', 28060))).toBeNull();
    expect(assistantFor(cfg('admins', []), viewer('admin'))).not.toBeNull();
  });
  it('the default config makes 28060 (Roey) a tester', () => {
    expect(assistantFor(DEFAULT_ASSISTANT_CONFIG, viewer('user', 28060))).toEqual(DEFAULT_ASSISTANT_CONFIG);
  });
  it('everyone: fans, admins and guests', () => {
    for (const v of [viewer('user'), viewer('admin'), viewer('user', 9), undefined, null]) {
      expect(assistantFor(cfg('everyone'), v)).toEqual(cfg('everyone'));
    }
  });
});
