import { useQuery } from '@tanstack/react-query';
import { useAuthSession } from '@/lib/authSession';
import { trpc } from '@/lib/trpc';
import { useHomePageData } from '@/hooks/useHomePageData';
import { useVideoStatusCounts } from '@/hooks/useVideoStats';
import { HomeDashboardLayout } from '@/components/home/HomeDashboardLayout';
import LandingPage from '@/pages/LandingPage';

export default function HomeDashboard() {
  const session = useAuthSession();
  const hasSession = Boolean(session.data?.user);
  const { data: user, isLoading: meLoading } = useQuery(trpc.account.me.queryOptions(undefined, {
    enabled: hasSession && !session.isPending,
    retry: false,
    staleTime: 60_000,
  }));
  const isLoading = session.isPending || (hasSession && meLoading);
  const currentUser = hasSession ? user ?? null : null;
  const data = useHomePageData({ userId: currentUser?.id ?? session.data?.user.id });
  const statistics = useVideoStatusCounts(hasSession);
  if (!currentUser && !isLoading) return <LandingPage />;
  return <HomeDashboardLayout currentUser={currentUser} username={session.data?.user.username ?? undefined} isLoading={isLoading} data={data} statistics={statistics} />;
}
