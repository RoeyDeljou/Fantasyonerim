import { EmailSchema } from '@fant/shared';

/** The normalized email (trimmed, lower-cased) when it is valid by the contract, else null. */
export function parseEmail(raw: string): string | null {
  const r = EmailSchema.safeParse(raw);
  return r.success ? r.data : null;
}
