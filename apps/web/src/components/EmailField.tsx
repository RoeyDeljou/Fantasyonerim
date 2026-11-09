'use client';

import type { InputHTMLAttributes } from 'react';
import { TextField } from './ui';

export { parseEmail } from '@/lib/email';

/**
 * The sign-in email input, the same everywhere (sign-up, sign-in, the pop-up for older accounts, Profile, Admin →
 * Users): email keyboard, autofill, always left-to-right so an address never renders scrambled in Hebrew.
 */
export function EmailField(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'dir'> & {
    label: string;
    hint?: string | undefined;
    error?: string | null | undefined;
  },
) {
  return (
    <TextField
      type="email"
      autoComplete="email"
      inputMode="email"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      placeholder="name@example.com"
      maxLength={254}
      {...props}
      dir="ltr"
    />
  );
}
