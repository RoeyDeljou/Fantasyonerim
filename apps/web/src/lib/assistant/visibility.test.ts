import { describe, expect, it } from 'vitest';
import { DEFAULT_ASSISTANT_CONFIG } from '@fant/shared';
import type { AssistantConfig } from '@fant/shared';
import { assistantFor } from './visibility';

const cfg = (visibility: AssistantConfig['visibility']): AssistantConfig => ({
  ...DEFAULT_ASSISTANT_CONFIG,
  visibility,
});

describe('assistantFor (who sees "Ask Alfie")', () => {
  it('hidden without a config (older API) and when off', () => {
    expect(assistantFor(null, 'admin')).toBeNull();
    expect(assistantFor(undefined, 'admin')).toBeNull();
    expect(assistantFor(cfg('off'), 'admin')).toBeNull();
    expect(assistantFor(cfg('off'), 'user')).toBeNull();
  });
  it('admins mode: only a signed-in admin', () => {
    expect(assistantFor(cfg('admins'), 'admin')).toEqual(cfg('admins'));
    expect(assistantFor(cfg('admins'), 'user')).toBeNull();
    expect(assistantFor(cfg('admins'), undefined)).toBeNull(); // guest / me still loading
  });
  it('everyone: fans, admins and guests', () => {
    for (const role of ['user', 'admin', undefined, null] as const) {
      expect(assistantFor(cfg('everyone'), role)).toEqual(cfg('everyone'));
    }
  });
});
