import { z } from 'zod';
import { badRequest } from './errors.js';

const CursorSchema = z.tuple([z.string().datetime({ offset: true }), z.string().min(1).max(100)]);

/** Opaque keyset cursor on (timestamp, id): base64url(JSON [iso, id]). */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(JSON.stringify([at.toISOString(), id])).toString('base64url');
}

export function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const [iso, id] = CursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { at: new Date(iso), id };
  } catch {
    throw badRequest('cursor: invalid or expired cursor');
  }
}
