import { EMAIL_TAKEN_MESSAGE } from '@fant/shared';
import { Prisma } from '@prisma/client';

/** 409 message whenever an email is already on another account (register, PATCH /v1/me, admin edit). */
export const EMAIL_TAKEN = EMAIL_TAKEN_MESSAGE;

/**
 * True when `err` is a unique-constraint violation (P2002) on the given User column. Prisma reports the target as
 * the field list (`['email']`) or, on some paths, the index name (`User_email_key`): both are accepted.
 */
export function isUniqueViolationOn(err: unknown, field: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') return false;
  const target: unknown = err.meta?.['target'];
  if (Array.isArray(target)) return target.includes(field);
  return typeof target === 'string' && target.includes(field);
}
