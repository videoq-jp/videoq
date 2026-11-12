import { features } from "@/lib/deployment";
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { appTrpcClient, trpc } from '@/lib/trpc';
import { useAuthSession } from '@/lib/authSession';
import { invalidateAfterCourseUpdate } from '@/lib/cacheInvalidation';
import { Link, useI18nNavigate } from '@/lib/i18n';
import { AuthPageIntro } from '@/components/layout/AuthPageIntro';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { MessageAlert } from '@/components/common/MessageAlert';
import { Button } from '@/components/ui/button';
import { ChipLabel } from '@/components/ui/chip-label';
import { UtilityLink } from '@/components/ui/utility-link';
import { CourseSharingNotice } from '@/components/video/course-detail/CourseSharingNotice';

export default function CourseInvitationPage() {
  const { token = '' } = useParams<{ token: string }>();
  const { t } = useTranslation();
  const navigate = useI18nNavigate();
  const session = useAuthSession();
  const queryClient = useQueryClient();
  const responding = useRef(false);

  const invitationQuery = useQuery(trpc.courseMemberships.preview.queryOptions({ token }, {
    enabled: Boolean(token),
    retry: false,
  }));

  const response = useMutation({
    mutationFn: async ({ token, decision }: { token: string; decision: 'accept' | 'decline' }) => decision === 'accept'
      ? appTrpcClient.courseMemberships.accept.mutate({ token })
      : appTrpcClient.courseMemberships.decline.mutate({ token }),
    onSuccess: async (result, { token }) => {
      await queryClient.cancelQueries(trpc.courseMemberships.preview.queryFilter({ token }));
      queryClient.setQueryData(trpc.courseMemberships.preview.queryKey({ token }), current =>
        current ? { ...current, status: result.status } : current);
      if (result.status === 'accepted') {
        await invalidateAfterCourseUpdate(queryClient, result.course_id);
      }
    },
    onSettled: () => { responding.current = false; },
  });
  const respond = (decision: 'accept' | 'decline') => {
    if (responding.current) return;
    responding.current = true;
    response.mutate({ token, decision }, {
      // Per-call callbacks stop when the recipient leaves this page.
      onSuccess: (result) => {
        if (result.status === 'accepted') navigate(`/videos/courses/${result.course_id}`);
      },
    });
  };

  const invitation = invitationQuery.data;
  const isSignedIn = Boolean(session.data?.user);
  const nextParam = encodeURIComponent(`/course-invitations/${token}`);
  const actionError = response.error;

  return (
    <>
      <AuthPageIntro
        badge={t('courseInvitation.badge')}
        title={t('courseInvitation.title')}
        description={t('courseInvitation.description')}
      />

      {invitationQuery.isLoading || session.isPending ? (
        <div className="flex justify-center py-12"><LoadingSpinner /></div>
      ) : invitationQuery.error || !invitation ? (
        <ErrorMessage message={t('courseInvitation.notFound')} />
      ) : response.data?.status === 'declined' ? (
        <MessageAlert type="success" message={t('courseInvitation.declined')} />
      ) : (
        <div className="space-y-6">
          <CourseSharingNotice method="invitation" />
          <div className="space-y-4 border border-solid-gray-420 bg-white p-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-std-20B-150 text-solid-gray-800">{invitation.course_name}</h2>
              <ChipLabel variant="filled-1" color="gray">
                {t(`courseInvitation.status.${invitation.status}`)}
              </ChipLabel>
            </div>
            <dl className="space-y-3 text-std-17N-170">
              <div>
                <dt className="text-solid-gray-600">{t('courseInvitation.inviter')}</dt>
                <dd className="font-bold text-solid-gray-800">{invitation.inviter_name}</dd>
              </div>
              <div>
                <dt className="text-solid-gray-600">{t('courseInvitation.recipient')}</dt>
                <dd className="font-mono text-solid-gray-800">{invitation.email_hint}</dd>
              </div>
            </dl>
          </div>

          {actionError ? <ErrorMessage message={actionError instanceof Error ? actionError.message : t('common.messages.error')} /> : null}

          {invitation.status !== 'pending' ? (
            <div className="space-y-4">
              <MessageAlert
                type="warning"
                message={t(`courseInvitation.terminal.${invitation.status}`)}
              />
              {invitation.status === 'accepted' ? (
                <Button asChild variant="solid" size="lg">
                  <Link href={`/videos/courses/${invitation.course_id}`}>
                    {t('courseInvitation.openCourse')}
                  </Link>
                </Button>
              ) : null}
            </div>
          ) : isSignedIn ? (
            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                variant="solid"
                size="lg"
                onClick={() => respond('accept')}
                disabled={response.isPending}
                aria-busy={response.isPending && response.variables.decision === 'accept'}
              >
                {response.isPending && response.variables.decision === 'accept' ? <InlineSpinner className="h-4 w-4" /> : null}
                {t('courseInvitation.accept')}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="lg"
                onClick={() => respond('decline')}
                disabled={response.isPending}
                aria-busy={response.isPending && response.variables.decision === 'decline'}
              >
                {response.isPending && response.variables.decision === 'decline' ? <InlineSpinner className="h-4 w-4" /> : null}
                {t('courseInvitation.decline')}
              </Button>
            </div>
          ) : (
            <div className="space-y-4">
              <MessageAlert type="warning" message={t(features.publicSignup ? 'courseInvitation.authRequired' : 'onprem.invitationAuthRequired')} />
              <div className="flex flex-wrap gap-4">
                <Button asChild variant="solid" size="lg">
                  <Link href={`/login?next=${nextParam}`}>{t('courseInvitation.login')}</Link>
                </Button>
                {features.publicSignup && <UtilityLink asChild>
                  <Link href={`/signup?next=${nextParam}`}>{t('courseInvitation.signup')}</Link>
                </UtilityLink>}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
