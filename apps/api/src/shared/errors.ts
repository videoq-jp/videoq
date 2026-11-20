import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import { ApplicationError, type FailureKind } from '../application/errors';

/** 新 API 契約のエラー封筒。 */
export const errorBodySchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  });

export type ErrorBody = z.infer<typeof errorBodySchema>;

export function toErrorBody(
  code: string,
  message: string,
  details?: unknown,
): ErrorBody {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
  };
}

/**
 * Application error converted to the shared JSON envelope by error-handler.
 */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly expose: boolean;
  readonly details?: unknown;

  constructor(
    status: ContentfulStatusCode,
    code: string,
    message: string,
    opts: { expose?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.expose = opts.expose ?? true;
    this.details = opts.details;
  }
}

const applicationStatuses = {
  validation: 400, too_large: 413, unauthorized: 401, forbidden: 403, not_found: 404,
  conflict: 409, unavailable: 503,
} as const satisfies Record<FailureKind, ContentfulStatusCode>;

/** Translate at transport boundaries, keeping existing API error envelopes. */
export function asApiError(error: unknown): ApiError | null {
  if (error instanceof ApiError) return error;
  if (!(error instanceof ApplicationError)) return null;
  return new ApiError(applicationStatuses[error.kind], error.code, error.message, {
    expose: error.expose, details: error.details,
  });
}

export const apiBadRequest = (message: string, code = "VALIDATION_ERROR", details?: unknown) =>
  new ApiError(400, code, message, { details });

export const apiNotFound = (message = "Not found", code = "NOT_FOUND") =>
  new ApiError(404, code, message);

export const apiConflict = (message: string, code = "CONFLICT") =>
  new ApiError(409, code, message);

export const apiServiceUnavailable = (
  message: string,
  code = "SERVICE_UNAVAILABLE",
  details?: unknown,
) => new ApiError(503, code, message, { details });
