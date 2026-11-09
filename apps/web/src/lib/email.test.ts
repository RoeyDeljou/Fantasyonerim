import { describe, expect, it } from 'vitest';
import { parseEmail } from './email';

describe('parseEmail', () => {
  it('normalizes a valid address (trim + lower-case), like the API', () => {
    expect(parseEmail('  Dana.Cohen@Example.COM ')).toBe('dana.cohen@example.com');
  });
  it('rejects what is not an address', () => {
    for (const bad of ['', 'dana', 'dana@', '@example.com', 'dana@example', 'da na@example.com', '<a@b.co>'])
      expect(parseEmail(bad)).toBeNull();
  });
});
