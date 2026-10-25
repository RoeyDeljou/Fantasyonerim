import { FplNotFoundError, FplUnavailableError } from '@fant/fpl';

// `name` fallback keeps the mapping working even if two copies of @fant/fpl get loaded (tsx + dist).
export function isFplNotFound(err: unknown): err is FplNotFoundError {
  return err instanceof FplNotFoundError || (err instanceof Error && err.name === 'FplNotFoundError');
}

export function isFplUnavailable(err: unknown): err is FplUnavailableError {
  return err instanceof FplUnavailableError || (err instanceof Error && err.name === 'FplUnavailableError');
}
