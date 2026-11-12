import { features } from "@/lib/deployment";
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { Link, useI18nNavigate, useLocale } from '@/lib/i18n';
import type { User } from '@/lib/api';
import { useAuthSession } from '@/lib/authSession';
import { trpc } from '@/lib/trpc';
import { useHomePageData } from '@/hooks/useHomePageData';
import { useVideoStatusCounts } from '@/hooks/useVideoStats';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { MessageAlert } from '@/components/common/MessageAlert';
import { AppPageHeader } from '@/components/layout/AppPageHeader';
import { Button } from '@/components/ui/button';
import { Heading, HeadingTitle } from '@/components/ui/heading';
import {
  MenuList,
  MenuListItem,
  MenuListItemButton,
  menuListItemVariants,
} from '@/components/ui/menu-list';
import { UtilityLink } from '@/components/ui/utility-link';
import { formatDate, getStatusLabel } from '@/lib/utils/video';
import { useTranslation } from 'react-i18next';
import LandingPage from '@/pages/LandingPage';
import { cn } from '@/lib/digital-agency/cn';
import { Upload } from 'lucide-react';
import { GettingStartedGuide } from '@/components/home/GettingStartedGuide';

export default function HomeDashboard() {
  const navigate = useI18nNavigate();
  const { t } = useTranslation();
  const locale = useLocale();

  const session = useAuthSession();
  const hasSession = Boolean(session.data?.user);
  const { data: user, isLoading: meLoading } = useQuery(trpc.account.me.queryOptions(undefined, {
    enabled: hasSession && !session.isPending,
    retry: false,
    staleTime: 60_000,
  }));
  const isLoading = session.isPending || (hasSession && meLoading);
  const currentUser = hasSession ? user ?? null : null;
  const usageSource: Partial<User> = currentUser ?? {};

  const {
    videos,
    courseCount,
    ownedCourse,
    hasCourseQuestions,
    isCourseQuestionsLoading,
    isLoading: isLoadingData,
  } = useHomePageData({ userId: currentUser?.id });
  const { stats: videoStats, isLoading: isVideoStatsLoading } = useVideoStatusCounts(!!currentUser?.id);

  const recentVideos = videos;

  const usageItems = useMemo(() => {
    const formatBytesToGb = (bytes?: number | null) => {
      if (bytes == null) return '0.0';
      return (bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1);
    };
    const formatSecondsToMinutes = (seconds?: number | null) => {
      if (seconds == null) return 0;
      return Math.ceil(seconds / 60);
    };

    return [
      {
        label: t('quota.usage.storage'),
        value: formatBytesToGb(usageSource.used_storage_bytes),
        limit:
          usageSource.storage_limit_bytes == null
            ? null
            : formatBytesToGb(usageSource.storage_limit_bytes),
        unit: t('quota.usage.gb'),
      },
      {
        label: t('quota.usage.monthlyUpload'),
        value: formatBytesToGb(usageSource.used_upload_bytes),
        limit: usageSource.monthly_upload_limit_bytes == null ? null : formatBytesToGb(usageSource.monthly_upload_limit_bytes),
        unit: t('quota.usage.gb'),
      },
      {
        label: t('quota.usage.transcription'),
        value: String(formatSecondsToMinutes(usageSource.used_processing_seconds)),
        limit:
          usageSource.processing_limit_seconds == null
            ? null
            : String(formatSecondsToMinutes(usageSource.processing_limit_seconds)),
        unit: t('quota.usage.min'),
      },
      {
        label: t('quota.usage.aiAnswers'),
        value: String(usageSource.used_ai_answers ?? 0),
        limit:
          usageSource.ai_answers_limit == null
            ? null
            : String(usageSource.ai_answers_limit),
      },
    ];
  }, [
    usageSource.ai_answers_limit,
    usageSource.storage_limit_bytes,
    usageSource.used_ai_answers,
    usageSource.used_processing_seconds,
    usageSource.used_storage_bytes,
    usageSource.used_upload_bytes,
    usageSource.monthly_upload_limit_bytes,
    usageSource.processing_limit_seconds,
    t,
  ]);

  if (isLoading || (currentUser && isLoadingData)) {
    return <LoadingSpinner fullScreen />;
  }

  if (!currentUser) {
    return <LandingPage />;
  }

  const inProgressCount = videoStats.processing + videoStats.pending + videoStats.indexing + videoStats.uploading;

  const statsItems = [
    { label: t('home.stats.totalVideos'), value: videoStats.total },
    { label: t('home.stats.analysisCompleted'), value: videoStats.completed },
    { label: t('home.stats.processing'), value: inProgressCount },
    { label: t('home.stats.courses'), value: courseCount },
  ];

  const actionItems = [
    {
      title: t('home.actions.upload.title'),
      description: t('home.actions.upload.descriptionLong'),
      onClick: () => navigate('/videos?upload=true'),
    },
    {
      title: t('home.actions.library.title'),
      description: t('home.actions.library.descriptionLong', { count: videoStats.total }),
      onClick: () => navigate('/videos'),
    },
    {
      title: t('home.actions.courses.title'),
      description: t('home.actions.courses.descriptionLong', { count: courseCount }),
      onClick: () => navigate('/videos/courses'),
    },
  ];

  return (
    <>
      <AppPageHeader
        badge={t('home.welcome.badge')}
        title={t('home.welcome.greeting', { username: currentUser?.username })}
        description={t('home.welcome.dailyMotivation')}
        action={(
          <Button
            variant="solid"
            size="md"
            onClick={() => navigate('/videos?upload=true')}
            className="shrink-0"
          >
            <Upload className="mr-2 h-4 w-4" />
            {t('home.actions.upload.title')}
          </Button>
        )}
      />

      {/* Wait for the counts and question history so the wrong step does not flash. */}
      {!isVideoStatsLoading && !isCourseQuestionsLoading && (
        <GettingStartedGuide
          userId={currentUser.id}
          progress={{
            hasVideos: videoStats.total > 0,
            hasProcessingVideos: inProgressCount > 0,
            hasCompletedVideos: videoStats.completed > 0,
            hasCourse: ownedCourse !== null,
            hasCourseVideos: (ownedCourse?.video_count ?? 0) > 0,
            hasAskedQuestion: hasCourseQuestions,
          }}
          courseHref={ownedCourse ? `/videos/courses/${ownedCourse.id}` : null}
          onUpload={() => navigate('/videos?upload=true')}
        />
      )}

      {/* All zeros tell a new user nothing; the guide above covers that case. */}
      {videoStats.total > 0 && (
        <section className="mb-16 md:mb-24">
          <Heading size="32" className="text-std-24B-150 md:text-std-32B-150 mb-4">
            <HeadingTitle level="h2">{t('home.stats.summaryTitle')}</HeadingTitle>
          </Heading>
          <dl className="grid grid-cols-1 border-t border-solid-gray-420 sm:grid-cols-2 lg:grid-cols-4">
            {statsItems.map(({ label, value }) => (
              <div
                key={label}
                className="flex items-baseline justify-between gap-4 border-b border-solid-gray-200 py-4 sm:pr-6"
              >
                <dt className="text-std-17N-170 text-solid-gray-700">{label}</dt>
                <dd className="text-std-20B-150 text-solid-gray-800">{value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      <section className="mb-16 md:mb-24">
        <Heading size="32" className="text-std-24B-150 md:text-std-32B-150 mb-4">
          <HeadingTitle level="h2">{t('home.actions.sectionTitle')}</HeadingTitle>
        </Heading>
        <MenuList className="border-t border-solid-gray-420">
          {actionItems.map((item) => (
            <MenuListItem key={item.title} className="border-b border-solid-gray-200">
              <MenuListItemButton
                type="box"
                size="regular"
                onClick={item.onClick}
                className="w-full flex-col items-start gap-1 py-4"
              >
                <span className="text-std-17B-170 text-solid-gray-800 group-hover/menu-list-item:underline">
                  {item.title}
                </span>
                <span className="text-std-17N-170 font-normal text-solid-gray-700">
                  {item.description}
                </span>
              </MenuListItemButton>
            </MenuListItem>
          ))}
        </MenuList>
      </section>

      <section className="mb-16 md:mb-24">
        <Heading size="32" className="text-std-24B-150 md:text-std-32B-150 mb-4">
          <HeadingTitle level="h2">{t('home.usage.title')}</HeadingTitle>
        </Heading>
        <p className="mb-4 text-std-17N-170 text-solid-gray-700">{t('home.usage.description')}</p>
        <dl className="border-t border-solid-gray-420">
          {usageItems.map(({ label, value, limit, unit }) => (
            <div
              key={label}
              className="flex flex-col gap-1 border-b border-solid-gray-200 py-4 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6"
            >
              <dt className="text-std-17N-170 text-solid-gray-700">{label}</dt>
              <dd className="text-std-17B-170 text-solid-gray-800">
                {value}
                {unit ? <span className="ml-1 font-normal text-solid-gray-700">{unit}</span> : null}
                <span className="mx-2 text-solid-gray-420">/</span>
                {limit ?? t('quota.usage.unlimited')}
                {unit && limit !== null ? (
                  <span className="ml-1 font-normal text-solid-gray-700">{unit}</span>
                ) : null}
              </dd>
            </div>
          ))}
        </dl>
        {currentUser.is_over_quota && (
          <div className="mt-4">
            <MessageAlert type="error" message={t('quota.errors.overQuota')} />
          </div>
        )}
        {features.billing && (currentUser.plan_code ?? 'free') === 'free' && (
          <div className="mt-4">
            <Button asChild variant="outline">
              <Link href="/pricing">{t('home.usage.upgrade')}</Link>
            </Button>
          </div>
        )}
      </section>

      {recentVideos.length > 0 && (
        <section className="mb-8">
          <div className="mb-4 flex items-end justify-between gap-4">
            <Heading size="32" className="text-std-24B-150 md:text-std-32B-150">
              <HeadingTitle level="h2">{t('home.recentVideos.title')}</HeadingTitle>
            </Heading>
            <UtilityLink asChild>
              <Link href="/videos">{t('home.recentVideos.viewAll')}</Link>
            </UtilityLink>
          </div>
          <ul className="border-t border-solid-gray-420">
            {recentVideos.map((video) => (
              <li key={video.id} className="border-b border-solid-gray-200">
                <Link
                  href={`/videos/${video.id}`}
                  className={cn(
                    menuListItemVariants(),
                    'w-full justify-between gap-4 py-4 no-underline',
                  )}
                  data-type="box"
                  data-size="regular"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-std-17B-170 text-solid-gray-800">
                      {video.title}
                    </span>
                    <span className="mt-1 block text-dns-14N-130 text-solid-gray-600">
                      {t(getStatusLabel(video.status))}
                      <span className="mx-2 text-solid-gray-300">|</span>
                      {formatDate(video.uploaded_at, 'full', locale)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
