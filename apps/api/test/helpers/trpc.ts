import { createApp } from "../../src/app";

export function requestTrpc(
  procedure: string,
  kind: "query" | "mutation",
  input: unknown,
  init: Omit<RequestInit, "method" | "body"> = {},
  env: unknown = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (kind === "mutation") headers.set("content-type", "application/json");
  const encodedInput = input === undefined
    ? ""
    : `?input=${encodeURIComponent(JSON.stringify(input))}`;
  return createApp().request(
    `/api/trpc/${procedure}${kind === "query" ? encodedInput : ""}`,
    {
      ...init,
      method: kind === "mutation" ? "POST" : "GET",
      headers,
      ...(kind === "mutation" && input !== undefined
        ? { body: JSON.stringify(input) }
        : {}),
    },
    env as never,
  );
}

export async function trpcData<T>(response: Response): Promise<T> {
  const payload = await response.json<{ result: { data: T } }>();
  return payload.result.data;
}

export async function trpcError(response: Response): Promise<{
  code: string;
  message: string;
  details?: unknown;
}> {
  const payload = await response.json<{
    error: {
      message: string;
      data: { code: string; applicationCode?: string; details?: unknown };
    };
  }>();
  return {
    code: payload.error.data.applicationCode ?? payload.error.data.code,
    message: payload.error.message,
    ...(payload.error.data.details !== undefined
      ? { details: payload.error.data.details }
      : {}),
  };
}
