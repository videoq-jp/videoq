import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw';
import { setupWorker } from 'msw/browser';
import { HttpNetworkFrame } from 'msw/experimental';
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@videoq/trpc';
import type { AuthFixture } from '../fixtures/auth';

type Inputs = inferRouterInputs<AppRouter>;
type Outputs = inferRouterOutputs<AppRouter>;
type ProcedurePath = {
  [R in keyof Inputs]: `${R}.${keyof Inputs[R] & string}`
}[keyof Inputs];
type AtPath<T, P extends string> = P extends `${infer R}.${infer K}`
  ? R extends keyof T ? K extends keyof T[R] ? T[R][K] : never : never : never;

type MockReply<T> =
  | { state: 'success'; data: T }
  | { state: 'pending' }
  | { state: 'error'; message: string; status: 400 | 401 | 403 | 404 | 500 };
export const success = <T,>(data: T): MockReply<T> => ({ state: 'success', data });
export const pending = (): MockReply<never> => ({ state: 'pending' });
export const failure = (message = 'サンプルデータを読み込めませんでした', status: 400 | 401 | 403 | 404 | 500 = 500): MockReply<never> => ({ state: 'error', message, status });

interface ProcedureMock {
  path: string;
  method: 'GET' | 'POST';
  resolve: (input: unknown) => MockReply<unknown>;
}

function procedure<P extends ProcedurePath>(method: ProcedureMock['method'], path: P,
  reply: MockReply<AtPath<Outputs, P>> | ((input: AtPath<Inputs, P>) => MockReply<AtPath<Outputs, P>>),
): ProcedureMock {
  return { path, method, resolve: (input) => typeof reply === 'function' ? reply(input as AtPath<Inputs, P>) : reply };
}
export const trpcQuery = <P extends ProcedurePath>(path: P, reply: Parameters<typeof procedure<P>>[2]) => procedure('GET', path, reply);
export const trpcMutation = <P extends ProcedurePath>(path: P, reply: Parameters<typeof procedure<P>>[2]) => procedure('POST', path, reply);

interface ApiScenario {
  auth?: AuthFixture;
  trpc?: ProcedureMock[];
  rest?: HttpHandler[];
}
declare module 'storybook/internal/csf' {
  interface Parameters { api?: ApiScenario }
}

// Each resolver captures its story's signal, so old pending work cannot join the next story.
let lifetime = new AbortController();
export function resetMockRequests() {
  lifetime.abort();
  lifetime = new AbortController();
}
export function disposeMockRequests() { lifetime.abort(); }

async function holdRequest(request: Request, signal: AbortSignal) {
  if (signal.aborted || request.signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', finish);
      request.signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    request.signal.addEventListener('abort', finish, { once: true });
  });
}

const errors = {
  400: { code: 'BAD_REQUEST', number: -32600 },
  401: { code: 'UNAUTHORIZED', number: -32001 },
  403: { code: 'FORBIDDEN', number: -32003 },
  404: { code: 'NOT_FOUND', number: -32004 },
  500: { code: 'INTERNAL_SERVER_ERROR', number: -32603 },
} as const;

export function trpcHandler(procedures: ProcedureMock[]): HttpHandler {
  const signal = lifetime.signal;
  return http.all('/api/trpc/:procedures', async ({ request, params }) => {
    const url = new URL(request.url);
    const batched = url.searchParams.get('batch') === '1';
    const paths = String(params.procedures).split(',');
    const input = request.method === 'GET'
      ? JSON.parse(url.searchParams.get('input') ?? 'null')
      : await request.json();
    const results = await Promise.all(paths.map(async (path, index) => {
      const mock = procedures.find((item) => item.path === path && item.method === request.method);
      const missingMessage = `[Storybook MSW] Undefined tRPC procedure: ${request.method} ${path}`;
      if (!mock) console.error(missingMessage);
      const reply = mock ? mock.resolve(batched ? input?.[index] : input) : failure(missingMessage);
      if (reply.state === 'pending') {
        await holdRequest(request, signal);
        return { status: 503, body: { error: { message: 'Story disposed' } } };
      }
      if (reply.state === 'success') return { status: 200, body: { result: { data: reply.data } } };
      const error = errors[reply.status];
      return { status: reply.status, body: { error: {
        message: reply.message, code: error.number,
        data: { code: error.code, httpStatus: reply.status, path },
      } } };
    }));
    const status = results.every((result) => result.status === results[0].status) ? results[0].status : 207;
    return HttpResponse.json(batched ? results.map((result) => result.body) : results[0].body, { status });
  });
}

// These handlers remain ordinary MSW handlers: use http.* directly for multipart, CSV, etc.
export function restPost(path: `/api/${string}`, reply: MockReply<JsonBodyType>) {
  return http.post(path, async ({ request }) => {
    if (reply.state === 'pending') {
      await holdRequest(request, lifetime.signal);
      return new HttpResponse(null, { status: 503 });
    }
    if (reply.state === 'error') return HttpResponse.json({ message: reply.message, code: errors[reply.status].code }, { status: reply.status });
    return HttpResponse.json(reply.data);
  });
}

export async function setupMockWorker() {
  const mustBlock = (request: Request) => {
    const url = new URL(request.url);
    return url.pathname === '/api' || url.pathname.startsWith('/api/')
      || !['GET', 'HEAD'].includes(request.method) || url.origin !== window.location.origin;
  };
  // An initial handler survives resetHandlers and runs after explicit story handlers.
  // onUnhandledFrame reports errors but is not a reliable browser network boundary.
  const worker = setupWorker(http.all('*', ({ request }) => {
    if (!mustBlock(request)) return;
    console.error(`[Storybook MSW] Blocked undefined request: ${request.method} ${request.url}`);
    return HttpResponse.error();
  }));
  await worker.start({
    quiet: true,
    onUnhandledFrame({ frame, defaults }) {
      if (frame instanceof HttpNetworkFrame && mustBlock(frame.data.request)) defaults.error();
    },
  });
  return worker;
}
