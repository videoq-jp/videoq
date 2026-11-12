import { fn, mocked } from 'storybook/test';
import type { StoryContext } from '@storybook/react-vite';
import { http, HttpResponse } from 'msw';
import { useAuthSession } from '@/lib/authSession';
import { appQueryClient } from '@/lib/queryClient';
import { authFixtures } from '../fixtures/auth';
import { disposeMockRequests, failure, resetMockRequests, success, trpcHandler, trpcQuery } from './network';

export async function prepareStoryEnvironment({ parameters, msw }: StoryContext) {
  await appQueryClient.cancelQueries();
  appQueryClient.clear();
  resetMockRequests();
  // Conversation IDs persist across remounts within a story, never across stories.
  for (const key of Object.keys(localStorage)) {
    if (/^videoq:conversations:v[12]:/.test(key)) localStorage.removeItem(key);
  }
  const auth = structuredClone(parameters.api?.auth ?? authFixtures.loggedOut);
  mocked(useAuthSession).mockReturnValue({
    data: auth.session,
    error: null,
    isPending: false,
    isRefetching: false,
    refetch: fn(async () => undefined),
  });
  const procedures = parameters.api?.trpc ?? [];
  if (procedures.some(({ path }) => path === 'account.me')) {
    throw new Error('Set parameters.api.auth to keep session and account.me consistent.');
  }
  msw.use(
    ...(parameters.api?.rest ?? []),
    http.get('/api/auth/get-session', () => HttpResponse.json(auth.session)),
    trpcHandler([trpcQuery('account.me', auth.profile ? success(auth.profile) : failure('Authentication required', 401)), ...procedures]),
  );
  return async () => {
    await appQueryClient.cancelQueries();
    appQueryClient.clear();
    disposeMockRequests();
    msw.resetHandlers();
    mocked(useAuthSession).mockReset();
  };
}
