import { useAuthSession } from '@/lib/authSession';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Navigate } from 'react-router-dom';
import { isOnprem } from '@/lib/deployment';
import LandingPage from '@/pages/LandingPage';

import { lazy, Suspense } from 'react';
import { HomeDashboardPending } from '@/components/home/HomeDashboardLayout';
const HomeDashboard = lazy(() => import('@/pages/HomeDashboard'));

export default function HomePage() {
  const session = useAuthSession();

  // Public content is ready immediately, including while the cookie session is checked.
  if (!session.data?.user) {
    if (isOnprem) return session.isPending ? <LoadingSpinner fullScreen /> : <Navigate to="/login" replace />;
    return <LandingPage />;
  }

  return <Suspense fallback={<HomeDashboardPending username={session.data.user.username ?? undefined} />}><HomeDashboard /></Suspense>;
}
