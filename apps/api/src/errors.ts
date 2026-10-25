import type { ApiErrorCode } from '@fant/shared';

/** Thrown by route handlers; rendered by the uniform error handler as `ApiError`. */
export class ApiHttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApiHttpError';
  }
}

export const badRequest = (message: string) => new ApiHttpError(400, 'bad_request', message);
export const unauthorized = (message = 'Sign in required') => new ApiHttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Admins only') => new ApiHttpError(403, 'forbidden', message);
export const notFound = (message: string) => new ApiHttpError(404, 'not_found', message);
export const conflict = (message: string) => new ApiHttpError(409, 'conflict', message);
