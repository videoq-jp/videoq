import { TRPCError, type TRPC_ERROR_CODE_KEY } from "@trpc/server";
import type {
  ProcedureHandlers,
  ProcedureName,
  RpcCaller,
  RpcInputMap,
  RpcOutputMap,
} from "@videoq/trpc";
import { asApiError } from "../../shared/errors";
import { isAPIError } from "better-auth/api";

export type HandlersFor<Domain extends string> = Pick<
  ProcedureHandlers,
  Extract<ProcedureName, `${Domain}.${string}`>
>;

export function rpcError(
  code: TRPC_ERROR_CODE_KEY,
  message: string,
  cause?: unknown,
): never {
  throw new TRPCError({ code, message, cause });
}

export function apiStatusToTrpcCode(status: number): TRPC_ERROR_CODE_KEY {
  switch (status) {
    case 400:
      return "BAD_REQUEST";
    case 401:
      return "UNAUTHORIZED";
    case 403:
      return "FORBIDDEN";
    case 404:
      return "NOT_FOUND";
    case 409:
      return "CONFLICT";
    case 410:
      return "CONFLICT";
    case 412:
      return "PRECONDITION_FAILED";
    case 413:
      return "PAYLOAD_TOO_LARGE";
    case 429:
      return "TOO_MANY_REQUESTS";
    case 503:
      return "INTERNAL_SERVER_ERROR";
    default:
      return "INTERNAL_SERVER_ERROR";
  }
}

function normalizeError(error: unknown): never {
  if (error instanceof TRPCError) throw error;
  if (isAPIError(error)) {
    throw new TRPCError({
      code: apiStatusToTrpcCode(error.statusCode),
      message: error.statusCode < 500 ? error.message : "Request failed",
      cause: error,
    });
  }
  const failure = asApiError(error);
  if (failure) {
    throw new TRPCError({
      code: apiStatusToTrpcCode(failure.status),
      message: failure.expose ? failure.message : "Request failed",
      cause: { appCode: failure.code, details: failure.details, cause: error },
    });
  }
  throw error;
}

export function createRpcCaller(handlers: ProcedureHandlers, beforeCall?: (name: ProcedureName) => void): RpcCaller {
  return async <Name extends ProcedureName>(
    name: Name,
    input: RpcInputMap[Name],
  ): Promise<RpcOutputMap[Name]> => {
    try {
      beforeCall?.(name);
      return await handlers[name](input);
    } catch (error) {
      return normalizeError(error);
    }
  };
}

export function requireUserId(userId: string | null): string {
  if (userId === null) {
    return rpcError("UNAUTHORIZED", "Authentication credentials were not provided.");
  }
  return userId;
}
