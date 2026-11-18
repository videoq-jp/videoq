import { createTRPCClient, httpBatchLink, splitLink, type TRPCClientError, type TRPCLink } from '@trpc/client'
import { createTRPCOptionsProxy } from '@trpc/tanstack-react-query'
import { observable } from '@trpc/server/observable'
import type { AppRouter } from '@videoq/trpc'
import { TRPC_MAX_BATCH_SIZE } from '@videoq/trpc/schema'
import { API_URL } from '@/lib/apiConfig'
import i18n from '@/i18n/config'
import { appQueryClient } from './queryClient'
import { ApiResponseError, fetchJsonResponse } from './jsonFetch'

export const TRPC_UNAUTHORIZED_EVENT = 'videoq:trpc-unauthorized'

interface AppTrpcClientOptions {
  baseUrl?: string
  fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
  onUnauthorized?: () => void | Promise<void>
}

function createUnauthorizedHandler(onUnauthorized: AppTrpcClientOptions['onUnauthorized']) {
  // All failed procedures in one HTTP batch share the same Response.
  const handledResponses = new WeakMap<Response, Promise<void>>()
  return (response: Response | undefined): Promise<void> => {
    const pending = response && handledResponses.get(response)
    if (pending) return pending
    const notification = Promise.resolve().then(() => {
      if (onUnauthorized) return onUnauthorized()
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event(TRPC_UNAUTHORIZED_EVENT))
      }
    }).catch(() => {
      // A failed logout/redirect must not replace the original tRPC error.
    })
    if (response) handledResponses.set(response, notification)
    return notification
  }
}

function unauthorizedLink(notify: ReturnType<typeof createUnauthorizedHandler>): TRPCLink<AppRouter> {
  return () => ({ op, next }) => observable((observer) => next(op).subscribe({
    next: (value) => observer.next(value),
    complete: () => observer.complete(),
    error: (error: TRPCClientError<AppRouter>) => {
      const response = error.meta?.response instanceof Response ? error.meta.response : undefined
      if (error.data?.code === 'UNAUTHORIZED' || response?.status === 401) {
        void notify(response).then(() => observer.error(error))
      } else {
        observer.error(error)
      }
    },
  }))
}

export function createAppTrpcClient(settings: AppTrpcClientOptions = {}) {
  const baseUrl = (settings.baseUrl ?? API_URL).replace(/\/+$/, '')
  const fetchFn = settings.fetchFn ?? fetch
  const notifyUnauthorized = createUnauthorizedHandler(settings.onUnauthorized)
  const transportOptions: Parameters<typeof httpBatchLink<AppRouter>>[0] = {
    url: `${baseUrl}/trpc`,
    maxItems: TRPC_MAX_BATCH_SIZE,
    headers: () => ({ 'Accept-Language': i18n.language }),
    async fetch(url, requestInit) {
      let response: Response
      try {
        response = await fetchJsonResponse(url, { ...requestInit, credentials: 'include' }, fetchFn)
      } catch (error) {
        if (error instanceof ApiResponseError && error.status === 401) await notifyUnauthorized(undefined)
        throw error
      }
      // A proxy may return a 401 without a valid tRPC JSON body.
      if (response.status === 401) await notifyUnauthorized(response)
      return response
    },
  };
  return createTRPCClient<AppRouter>({
    links: [
      unauthorizedLink(notifyUnauthorized),
      splitLink({
        // Independent sections must not wait for the slowest procedure in a batch.
        condition: op => op.context.independentLoading === true,
        true: httpBatchLink({ ...transportOptions, maxItems: 1 }),
        false: httpBatchLink(transportOptions),
      }),
    ],
  })
}

export const appTrpcClient = createAppTrpcClient()

// Resolve the active cache when building options: AuthProvider replaces it when
// the signed-in user changes, including session updates from another tab.
export const trpc = createTRPCOptionsProxy<AppRouter>({
  client: appTrpcClient,
  queryClient: () => appQueryClient,
})
