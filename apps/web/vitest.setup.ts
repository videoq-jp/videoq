import { afterEach, beforeEach, expect, vi } from 'vitest'
import { cleanup } from '@testing-library/react'
import * as matchers from '@testing-library/jest-dom/matchers'
import React from 'react'
import { QueryClientProvider } from '@tanstack/react-query'
import { createAppQueryClient } from './src/lib/queryClient'
import { FeedbackProvider } from './src/components/common/FeedbackProvider'
import enTranslation from './src/i18n/locales/en/translation.json'
import jaTranslation from './src/i18n/locales/ja/translation.json'

// Register on this workspace's Vitest; a hoisted jest-dom can resolve the API's Vitest 4.
expect.extend(matchers)

type MockAuthUser = { id: string; name?: string; email?: string };
type TrpcTestHandler = (input: unknown) => unknown;

const trpcTestHandlers = new Map<string, TrpcTestHandler>();
// Share defaults and cache between tRPC options and React, with a fresh client per test.
let testQueryClient = createAppQueryClient();

function decodeTrpcInput(value: unknown): unknown {
  if (
    value !== null
    && typeof value === 'object'
    && 'json' in value
  ) {
    return (value).json;
  }
  return value;
}

async function trpcTestFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost');
  const procedures = decodeURIComponent(url.pathname.split('/trpc/')[1] ?? '')
    .split(',')
    .filter(Boolean);
  const encodedInput = init?.method === 'POST'
    ? typeof init.body === 'string' ? init.body : null
    : url.searchParams.get('input');
  const batchInput = encodedInput
    ? JSON.parse(encodedInput) as Record<string, unknown>
    : {};

  const responses = await Promise.all(procedures.map(async (procedure, index) => {
    const handler = trpcTestHandlers.get(procedure);
    if (!handler) {
      return {
        error: {
          message: `No tRPC test handler registered for ${procedure}`,
          code: -32601,
          data: { code: 'NOT_FOUND', httpStatus: 404 },
        },
      };
    }

    try {
      const data = await handler(decodeTrpcInput(batchInput[String(index)]));
      return { result: { data } };
    } catch (error) {
      return {
        error: {
          message: error instanceof Error ? error.message : String(error),
          code: -32000,
          data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 },
        },
      };
    }
  }));

  return new Response(JSON.stringify(responses), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

vi.mock('@/lib/trpc', async () => {
  const actual = await vi.importActual<typeof import('./src/lib/trpc')>('@/lib/trpc')
  const { createTRPCOptionsProxy } = await import('@trpc/tanstack-react-query')
  const client = actual.createAppTrpcClient({ fetchFn: trpcTestFetch })
  return {
    ...actual,
    appTrpcClient: client,
    trpc: createTRPCOptionsProxy({
      client,
      queryClient: () => testQueryClient,
    }),
  }
})

/** Mutable BA session for tests — gate auth UI without hitting /api/auth/get-session. */
const authSessionState = vi.hoisted(() => ({
  data: { user: { id: '1', name: 'testuser', email: 'test@example.com' } },
  isPending: false,
  refetch: vi.fn(async () => {}),
}));

vi.mock('@/lib/authSession', () => ({
  useAuthSession: () => ({
    data: authSessionState.data,
    isPending: authSessionState.isPending,
    isRefetching: false,
    error: null,
    refetch: authSessionState.refetch,
  }),
}));

vi.mock('@testing-library/react', async () => {
  const actual = await vi.importActual<typeof import('@testing-library/react')>('@testing-library/react')

  const createWrapper = (UserWrapper?: React.ComponentType<any>) => {
    const TestQueryWrapper = ({ children, ...props }: { children?: React.ReactNode } & Record<string, unknown>) => {
      const [queryClient] = React.useState(() => testQueryClient)
      const content = React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(FeedbackProvider, {}, children),
      )
      if (!UserWrapper) {
        return content
      }
      return React.createElement(UserWrapper, props, content)
    }

    return TestQueryWrapper
  }

  const render: typeof actual.render = (ui: any, options?: any) => {
    const wrapper = createWrapper(options?.wrapper)
    return actual.render(ui, { ...options, wrapper })
  }

  const renderHook: typeof actual.renderHook = (callback: any, options?: any) => {
    const wrapper = createWrapper(options?.wrapper)
    return actual.renderHook(callback, { ...options, wrapper })
  }

  return {
    ...actual,
    render,
    renderHook,
  }
})

declare global {
  interface GlobalThis {
    __setMockAuthSession: (data: { user: MockAuthUser } | null, isPending?: boolean) => void
    __setMockPathname: (pathname: string) => void
    __setMockSearchParams: (search: string) => void
    __getMockSetSearchParams: () => ReturnType<typeof vi.fn>
    __setMockLanguage: (language: 'en' | 'ja') => void
    __setTrpcHandler: (procedure: string, handler: TrpcTestHandler) => void
    __clearTrpcHandlers: () => void
  }
}

globalThis.__setMockAuthSession = (data, isPending = false) => {
  authSessionState.data = data
  authSessionState.isPending = isPending
}
globalThis.__setTrpcHandler = (procedure, handler) => {
  trpcTestHandlers.set(procedure, handler)
}
globalThis.__clearTrpcHandlers = () => {
  trpcTestHandlers.clear()
}

beforeEach(() => {
  testQueryClient = createAppQueryClient()
  trpcTestHandlers.clear()
  authSessionState.data = { user: { id: '1', name: 'testuser', email: 'test@example.com' } }
  authSessionState.isPending = false
})

class MockIntersectionObserver implements IntersectionObserver {
  readonly root = null
  readonly rootMargin = '0px'
  readonly thresholds = [0]

  constructor(private callback: IntersectionObserverCallback) {}

  disconnect(): void {}
  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this,
    )
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  unobserve(): void {}
}

Object.defineProperty(globalThis, 'IntersectionObserver', {
  writable: true,
  configurable: true,
  value: MockIntersectionObserver,
})

// jsdom does not implement HTMLDialogElement.showModal/close.
if (typeof HTMLDialogElement !== 'undefined') {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
}

// Cleanup after each test
afterEach(() => {
  cleanup()
  testQueryClient.clear()
  mockLocation.search = ''
  mockSetSearchParams.mockClear()
})

// Mock React Router
const mockNavigate = vi.fn()
const mockSetSearchParams = vi.fn((nextInit: URLSearchParams | string) => {
  const next = nextInit instanceof URLSearchParams
    ? nextInit
    : new URLSearchParams(nextInit)
  const nextSearch = next.toString()
  mockLocation.search = nextSearch ? `?${nextSearch}` : ''
})
const mockLocation: {
  pathname: string
  search: string
  hash: string
  state: unknown
  key: string
} = { pathname: '/', search: '', hash: '', state: null, key: 'default' }
let mockLanguage: 'en' | 'ja' = 'en'

const seoTranslations = {
  en: enTranslation.seo,
  ja: jaTranslation.seo,
} as const

const lookupSeoTranslation = (language: 'en' | 'ja', key: string): string | undefined => {
  if (!key.startsWith('seo.')) {
    return undefined
  }

  let current: unknown = seoTranslations[language]
  for (const segment of key.split('.').slice(1)) {
    if (!current || typeof current !== 'object' || !(segment in current)) {
      return undefined
    }
    current = (current as Record<string, unknown>)[segment]
  }

  return typeof current === 'string' ? current : undefined
}

// Allow tests to control the (de-localized) pathname returned by useLocation/useI18nLocation
globalThis.__setMockPathname = (pathname: string) => {
  mockLocation.pathname = pathname
}
globalThis.__setMockSearchParams = (search: string) => {
  const normalizedSearch = search.startsWith('?') ? search.slice(1) : search
  mockLocation.search = normalizedSearch ? `?${normalizedSearch}` : ''
}
globalThis.__getMockSetSearchParams = () => mockSetSearchParams
globalThis.__setMockLanguage = (language: 'en' | 'ja') => {
  mockLanguage = language
}

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom')
  type MockLinkProps = {
    children?: React.ReactNode
    to?: unknown
  } & Record<string, unknown>
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => mockLocation,
    useParams: () => ({}),
    useSearchParams: () => [new URLSearchParams(mockLocation.search), mockSetSearchParams],
    Link: ({ children, to, ...props }: MockLinkProps) =>
      React.createElement('a', { href: typeof to === 'string' ? to : '', ...props }, children),
  }
})

// Mock react-i18next
vi.mock('react-i18next', () => ({
  initReactI18next: {
    type: '3rdParty',
    init: () => undefined,
  },
  useTranslation: () => ({
    t: (key: string, optionsOrDefault?: string | Record<string, unknown>) => {
      const resolved = lookupSeoTranslation(mockLanguage, key)
      if (resolved) {
        return resolved
      }
      if (typeof optionsOrDefault === 'string') {
        return key
      }
      if (optionsOrDefault && typeof optionsOrDefault === 'object') {
        if ('returnObjects' in optionsOrDefault && key.endsWith('.bullets')) {
          return [`${key}.0`, `${key}.1`]
        }
        const rest = Object.fromEntries(
          Object.entries(optionsOrDefault).filter(([k]) => k !== 'defaultValue')
        )
        if (Object.keys(rest).length > 0) {
          return `${key} ${JSON.stringify(rest)}`
        }
        return key
      }
      return key
    },
    i18n: {
      language: mockLanguage,
      changeLanguage: vi.fn(),
    },
  }),
  Trans: ({ children }: { children?: React.ReactNode }) => children,
  I18nextProvider: ({ children }: { children?: React.ReactNode }) => children,
}))

// Mock AppNav to prevent useMutation/useQueryClient side effects in page tests
vi.mock('@/components/layout/AppNav', () => ({
  AppNav: () => null,
}))

// Mock i18n routing helpers
vi.mock('@/lib/i18n', () => ({
  useI18nNavigate: () => mockNavigate,
  useI18nLocation: () => mockLocation,
  removeLocalePrefix: (pathname: string) => pathname,
  addLocalePrefix: (pathname: string) => pathname,
  useLocale: () => mockLanguage,
  setPreferredLocale: vi.fn(),
  Link: ({ children, to, href, ...props }: { children?: React.ReactNode; to?: unknown; href?: string } & Record<string, unknown>) =>
    React.createElement('a', { href: href || (typeof to === 'string' ? to : ''), ...props }, children),
}))

// Mock the API client
vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>()
  return {
  ...actual,
  apiClient: {
    signup: vi.fn(() => Promise.resolve()),
    verifyEmail: vi.fn(() => Promise.resolve()),
    login: vi.fn(() => Promise.resolve()),
    loginWithGoogle: vi.fn(() => Promise.resolve()),
    requestPasswordReset: vi.fn(() => Promise.resolve()),
    confirmPasswordReset: vi.fn(() => Promise.resolve()),
    requestEmailChange: vi.fn(() => Promise.resolve()),
    updateUsername: vi.fn(() => Promise.resolve()),
    confirmEmailChange: vi.fn(() => Promise.resolve()),
    createIntegrationApiKey: vi.fn(),
    revokeIntegrationApiKey: vi.fn(() => Promise.resolve()),
    revokeAuthorizedOAuthToken: vi.fn(() => Promise.resolve()),
    chatStream: vi.fn(async function* () {}),
    exportChatHistoryCsv: vi.fn(() => Promise.resolve()),
    uploadToPresignedUrl: vi.fn(() => Promise.resolve()),
    uploadVideo: vi.fn(() => Promise.resolve()),
    getVideoUrl: vi.fn(actual.apiClient.getVideoUrl.bind(actual.apiClient)),
    getSharedVideoUrl: vi.fn(actual.apiClient.getSharedVideoUrl.bind(actual.apiClient)),
    logout: vi.fn(() => Promise.resolve()),
    setUnauthorizedHandler: vi.fn(),
  },
}});
