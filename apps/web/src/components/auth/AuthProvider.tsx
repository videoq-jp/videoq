import { useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider, type QueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api';
import { useI18nLocation, useI18nNavigate } from '@/lib/i18n';
import { isPublicAuthPath } from '@/lib/authConfig';
import { isKnownPath } from '@/lib/seo';
import { TRPC_UNAUTHORIZED_EVENT } from '@/lib/trpc';
import { useAuthSession } from '@/lib/authSession';
import { appQueryClient, replaceAppQueryClient } from '@/lib/queryClient';

interface AuthProviderProps {
  children: ReactNode;
  initialQueryClient?: QueryClient;
}

export function AuthProvider({ children, initialQueryClient = appQueryClient }: AuthProviderProps) {
  const navigate = useI18nNavigate();
  const location = useI18nLocation();
  const session = useAuthSession();
  const { refetch: refetchSession, isPending: sessionPending, error: sessionError } = session;
  const userId = session.data?.user.id ?? null;
  const [cache, setCache] = useState({ userId, queryClient: initialQueryClient });
  const { queryClient } = cache;
  const identityChanged = userId !== cache.userId;

  useEffect(() => {
    if (!identityChanged) return;

    // Better Auth also refreshes sessions after changes in another tab. Keep
    // consumers unmounted until the cache is replaced. Late mutation callbacks
    // can still write to their captured client, so clearing it alone is unsafe.
    queryClient.clear();
    let active = true;
    queueMicrotask(() => {
      if (active) setCache({ userId, queryClient: replaceAppQueryClient() });
    });
    return () => { active = false; };
  }, [identityChanged, queryClient, userId]);

  useEffect(() => {
    const unavailable = sessionError && sessionError.status !== 401 && sessionError.status !== 403;
    // Unknown URLs stay put so they show the 404 page instead of a login redirect.
    if (!sessionPending && !unavailable && !userId && !isPublicAuthPath(location.pathname) && isKnownPath(location.pathname)) {
      navigate('/login');
    }
  }, [location.pathname, navigate, sessionError, sessionPending, userId]);

  useEffect(() => {
    let pendingRefresh: Promise<void> | undefined;
    const revalidateSession = () => {
      // A response can belong to a request sent before an account switch.
      // Only the session endpoint can determine the current cookie's validity.
      pendingRefresh ??= Promise.resolve().then(() => refetchSession()).catch(() => {
        // Transient failures leave the session available for a later retry.
      }).finally(() => { pendingRefresh = undefined; });
      return pendingRefresh;
    };
    const handleTrpcUnauthorized = () => {
      void revalidateSession();
    };

    apiClient.setUnauthorizedHandler(revalidateSession);
    window.addEventListener(TRPC_UNAUTHORIZED_EVENT, handleTrpcUnauthorized);

    return () => {
      apiClient.setUnauthorizedHandler(undefined);
      window.removeEventListener(TRPC_UNAUTHORIZED_EVENT, handleTrpcUnauthorized);
    };
  }, [refetchSession]);

  return identityChanged ? null : (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}
