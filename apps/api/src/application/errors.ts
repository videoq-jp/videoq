/** Application failures describe intent, independent of HTTP or RPC status codes. */
export type FailureKind = 'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable';

export class ApplicationError extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly expose = true,
  ) {
    super(message);
    this.name = 'ApplicationError';
  }
}

export const notFound = (message = 'Not found', code = 'NOT_FOUND') =>
  new ApplicationError('not_found', code, message);
export const forbidden = (message: string) => new ApplicationError('forbidden', 'FORBIDDEN', message);
export const validationFailure = (message: string, code = 'VALIDATION_ERROR') =>
  new ApplicationError('validation', code, message);
export const conflict = (message: string, code = 'CONFLICT') => new ApplicationError('conflict', code, message);
export const unavailable = (message: string, code = 'SERVICE_UNAVAILABLE') =>
  new ApplicationError('unavailable', code, message);
