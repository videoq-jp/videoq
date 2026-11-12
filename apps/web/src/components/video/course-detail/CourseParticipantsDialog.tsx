import { Input } from "@/components/ui/input";
import { features } from "@/lib/deployment";
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQueryClient, useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { CourseInviteRecipientResult } from '@videoq/trpc';
import { normalizeInvitationEmail } from '@videoq/trpc/course-invitations';
import { appTrpcClient, trpc } from '@/lib/trpc';
import { trackLandingEvent } from '@/lib/landingAnalytics';
import { refreshQuery } from '@/lib/cacheInvalidation';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { useConfirm } from '@/components/common/feedback';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CourseSharingNotice } from './CourseSharingNotice';
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogHeading,
  DialogScrollArea,
  useDialog,
} from '@/components/ui/dialog';

/** 送信直後に配送状態を追う間隔と、追跡を打ち切るまでの時間。 */
const DELIVERY_POLL_INTERVAL_MS = 3_000;
const DELIVERY_POLL_WINDOW_MS = 30_000;

function splitEmails(value: string): string[] {
  return value
    .split(/[\n,;]+/)
    .map((email) => email.trim())
    .filter(Boolean);
}

type RecipientPreviewStatus =
  | 'ready'
  | 'invalid'
  | 'duplicate'
  | 'already_member'
  | 'already_invited';

type RecipientPreview = {
  email: string;
  status: RecipientPreviewStatus;
};

type ParticipantAction =
  | { kind: 'invite'; emails: string[] }
  | { kind: 'resend' | 'revoke'; invitationId: number }
  | { kind: 'remove'; userId: string };

function previewRecipients(
  inputs: readonly string[],
  memberEmails: ReadonlySet<string>,
  pendingEmails: ReadonlySet<string>,
): RecipientPreview[] {
  const seen = new Set<string>();
  return inputs.map((input) => {
    const normalized = normalizeInvitationEmail(input);
    if (!normalized) return { email: input, status: 'invalid' };
    if (seen.has(normalized)) return { email: normalized, status: 'duplicate' };
    seen.add(normalized);
    if (memberEmails.has(normalized)) {
      return { email: normalized, status: 'already_member' };
    }
    if (pendingEmails.has(normalized)) {
      return { email: normalized, status: 'already_invited' };
    }
    return { email: normalized, status: 'ready' };
  });
}

export function CourseParticipantsDialog({
  courseId,
  isOpen,
  onOpenChange,
}: {
  courseId: number;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const requestConfirmation = useConfirm();
  const [emailInput, setEmailInput] = useState('');
  const [inviteResults, setInviteResults] = useState<CourseInviteRecipientResult[]>([]);
  const resultsRef = useRef<HTMLUListElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const [focusRequest, setFocusRequest] = useState<{ target: 'results' | 'error' | 'heading' } | null>(null);
  // メール送信はサーバー側のキューで進むので、送信直後だけ配送状態を追う。
  // 恒久的なポーリングにしないよう、追跡する期間を明示的に区切る。
  const [trackDeliveryUntil, setTrackDeliveryUntil] = useState(0);
  const operationPending = useRef(false);

  const participantsQuery = useQuery({
    ...trpc.courseMemberships.participants.queryOptions({ courseId }),
    enabled: isOpen,
    refetchInterval: (query) => {
      if (!features.emailDelivery) return false;
      if (Date.now() >= trackDeliveryUntil) return false;
      const queued = query.state.data?.invitations.some(
        (invitation) => invitation.status === 'pending' && invitation.delivery_status === 'queued',
      );
      return queued ? DELIVERY_POLL_INTERVAL_MS : false;
    },
  });
  const operation = useMutation({
    mutationFn: async (action: ParticipantAction) => {
      switch (action.kind) {
        case 'invite':
          return { kind: action.kind, courseId, ...await appTrpcClient.courseMemberships.invite.mutate({ courseId, emails: action.emails }) };
        case 'resend':
          return { ...action, courseId, ...await appTrpcClient.courseMemberships.resend.mutate({ courseId, invitationId: action.invitationId }) };
        case 'revoke':
          await appTrpcClient.courseMemberships.revoke.mutate({ courseId, invitationId: action.invitationId });
          return { ...action, courseId };
        case 'remove':
          await appTrpcClient.courseMemberships.removeMember.mutate({ courseId, userId: action.userId });
          return { ...action, courseId };
      }
    },
    onSuccess: async (result) => {
      const filter = trpc.courseMemberships.participants.queryFilter({ courseId: result.courseId });
      if (result.kind === 'invite' || result.kind === 'resend') {
        if (result.kind === 'resend' && 'invitation_url' in result && result.invitation_url) {
          const email = participantsQuery.data?.invitations.find(invitation => invitation.id === result.invitationId)?.email || '';
          setInviteResults([{ email, status: 'queued', invitation_url: result.invitation_url }]);
        }
        if (result.kind === 'invite') {
          if (result.results.some(recipient => recipient.status === 'queued')) trackLandingEvent('course_invite_queued');
          setInviteResults(result.results);
          setEmailInput('');
        }
        setTrackDeliveryUntil(Date.now() + DELIVERY_POLL_WINDOW_MS);
        await refreshQuery(queryClient, filter);
        return;
      }
      await queryClient.cancelQueries(filter);
      queryClient.setQueryData(trpc.courseMemberships.participants.queryKey({ courseId: result.courseId }), current => {
        if (!current) return current;
        return result.kind === 'remove'
          ? { ...current, members: current.members.filter(member => member.user_id !== result.userId) }
          : { ...current, invitations: current.invitations.map(invitation => invitation.id === result.invitationId
            ? { ...invitation, status: 'revoked' as const } : invitation) };
      });
    },
    onSettled: (_, error, action) => {
      operationPending.current = false;
      setFocusRequest({ target: error ? 'error' : action.kind === 'invite' ? 'results' : 'heading' });
    },
  });

  const runOperation = (action: ParticipantAction) => {
    if (operationPending.current) return;
    operationPending.current = true;
    operation.mutate(action);
  };
  const pendingAction = operation.isPending ? operation.variables : null;
  const isInviting = pendingAction?.kind === 'invite';

  const participants = participantsQuery.data;
  const emailInputs = useMemo(() => splitEmails(emailInput), [emailInput]);
  const recipientPreview = useMemo(() => {
    const memberEmails = new Set(
      participants?.members.map((member) => member.email.trim().toLowerCase()) ?? [],
    );
    const pendingEmails = new Set(
      participants?.invitations
        .filter((invitation) => invitation.status === 'pending')
        .map((invitation) => invitation.email.trim().toLowerCase()) ?? [],
    );
    return previewRecipients(emailInputs, memberEmails, pendingEmails);
  }, [emailInputs, participants]);
  const readyRecipientCount = recipientPreview.filter(({ status }) => status === 'ready').length;

  const dialog = useDialog({
    open: isOpen,
    onOpenChange: (open) => {
      if (!open) closeDialog();
    },
    onRequestClose: (event) => {
      if (isInviting) event.preventDefault();
    },
  });

  const closeDialog = () => {
    if (isInviting) return;
    // Restore the opener's focus before the parent can unmount the dialog.
    dialog.dialogProps.ref.current?.close();
    setTrackDeliveryUntil(0);
    onOpenChange(false);
  };

  useEffect(() => {
    if (!focusRequest || !dialog.dialogProps.ref.current?.open) return;
    const target = focusRequest.target === 'error' ? errorRef.current
      : focusRequest.target === 'results' ? resultsRef.current
        : dialog.headingProps.ref.current;
    // Row actions can remove their own trigger. Focus the result only after
    // the updated participants have arrived, and never reopen a closed dialog.
    (target ?? dialog.headingProps.ref.current)?.focus();
  }, [focusRequest, dialog.dialogProps.ref, dialog.headingProps.ref]);
  if (!isOpen) return null;

  const confirmRemoveMember = async (member: { user_id: string; username: string }) => {
    const confirmed = await requestConfirmation({
      title: t('confirmations.removeMember', { name: member.username }),
      description: t('confirmations.removeMemberDescription'),
      confirmLabel: t('videos.courseMembers.remove'),
      variant: 'danger',
    });
    if (!confirmed) return;
    runOperation({ kind: 'remove', userId: member.user_id });
  };

  const removingUserId = pendingAction?.kind === 'remove' ? pendingAction.userId : null;
  const resendingInvitationId = pendingAction?.kind === 'resend' ? pendingAction.invitationId : null;
  const revokingInvitationId = pendingAction?.kind === 'revoke' ? pendingAction.invitationId : null;
  const mutationError = operation.error;

  return (
    <Dialog {...dialog.dialogProps} scroll="inner" width="min(48rem, 95vw)">
      <DialogContent>
        <DialogHeader>
          <DialogHeading {...dialog.headingProps}>{t('videos.courseMembers.title')}</DialogHeading>
        </DialogHeader>
        {/* Outside the scroll area on purpose: acting on a row further down the
            list would otherwise leave the failure message off screen. The
            padding mirrors DialogHeader / DialogBody so the banner lines up
            with the rest of the dialog at every breakpoint. */}
        {mutationError ? (
          <div ref={errorRef} tabIndex={-1} className="px-4 md:px-6 focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-2">
            <ErrorMessage message={mutationError instanceof Error ? mutationError.message : t('common.messages.error')} />
          </div>
        ) : null}
        <DialogScrollArea>
          <DialogBody>
            <div className="space-y-8">
              <CourseSharingNotice method="invitation" />
              <section className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="course-invitation-emails">{t('videos.courseMembers.emailLabel')}</Label>
                  <Textarea
                    id="course-invitation-emails"
                    rows={4}
                    value={emailInput}
                    onChange={(event) => setEmailInput(event.target.value)}
                    disabled={operation.isPending}
                  />
                  <p className="text-dns-14N-130 text-solid-gray-600">
                    {t('videos.courseMembers.emailHelp')}
                  </p>
                </div>
                {recipientPreview.length > 0 ? (
                  <div className="space-y-2">
                    <h3 className="text-std-17B-170">{t(features.emailDelivery ? 'videos.courseMembers.previewTitle' : 'onprem.invitePreview')}</h3>
                    <p className="text-dns-14N-130 text-solid-gray-600">
                      {t(features.emailDelivery ? 'videos.courseMembers.previewSummary' : 'onprem.invitePreviewSummary', {
                        count: readyRecipientCount,
                        total: recipientPreview.length,
                      })}
                    </p>
                    <ul className="divide-y divide-solid-gray-200 border border-solid-gray-300">
                      {recipientPreview.map((recipient, index) => (
                        <li
                          key={`${recipient.email}-${index}`}
                          className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-4 py-3"
                        >
                          <span className="min-w-0 max-w-full break-all">{recipient.email}</span>
                          <span className="shrink-0">
                            {recipient.status === 'ready'
                              ? t('videos.courseMembers.preview.ready')
                              : t(`videos.courseMembers.result.${recipient.status}`)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <Button
                  type="button"
                  onClick={() => runOperation({ kind: 'invite', emails: emailInputs })}
                  disabled={operation.isPending || readyRecipientCount === 0}
                  aria-busy={isInviting}
                >
                  {isInviting ? <InlineSpinner className="h-4 w-4" /> : null}
                  {t(features.emailDelivery ? 'videos.courseMembers.invite' : 'onprem.issueCourseLinks')}
                </Button>
                {inviteResults.length > 0 ? (
                  <ul ref={resultsRef} tabIndex={-1} className="divide-y divide-solid-gray-200 border border-solid-gray-300 focus-visible:outline-4 focus-visible:outline-black focus-visible:outline-offset-2">
                    {inviteResults.map((result, index) => (
                      <li key={`${result.email}-${index}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-4 py-3">
                        <span className="min-w-0 max-w-full break-all">{result.email}</span>
                        <span className="shrink-0">{t(!features.emailDelivery && result.status === 'queued' ? 'onprem.courseLinkReady' : `videos.courseMembers.result.${result.status}`)}</span>
                        {result.invitation_url && <Input className="w-full" aria-label={`${t('onprem.courseInvitationLink')}: ${result.email}`} value={result.invitation_url} readOnly onFocus={event => event.currentTarget.select()} />}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              {participantsQuery.isLoading ? (
                <div className="flex justify-center py-8"><LoadingSpinner /></div>
              ) : participantsQuery.error ? (
                <ErrorMessage message={participantsQuery.error instanceof Error ? participantsQuery.error.message : t('common.messages.error')} />
              ) : (
                <>
                  <section className="space-y-3">
                    <h3 className="text-std-18B-160">{t('videos.courseMembers.membersTitle')}</h3>
                    {participants?.members.length ? (
                      <ul className="divide-y divide-solid-gray-200 border border-solid-gray-300">
                        {participants.members.map((member) => (
                          <li key={member.user_id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                            <div>
                              <p className="font-bold">{member.username}</p>
                              <p className="break-all text-dns-14N-130 text-solid-gray-600">{member.email}</p>
                            </div>
                            <Button
                              type="button"
                              variant="text"
                              size="sm"
                              onClick={() => { void confirmRemoveMember(member); }}
                              disabled={operation.isPending}
                              aria-busy={removingUserId === member.user_id}
                            >
                              {removingUserId === member.user_id ? <InlineSpinner className="h-4 w-4" /> : null}
                              {t('videos.courseMembers.remove')}
                            </Button>
                          </li>
                        ))}
                      </ul>
                    ) : <p>{t('videos.courseMembers.noMembers')}</p>}
                  </section>

                  <section className="space-y-3">
                    <h3 className="text-std-18B-160">{t('videos.courseMembers.invitationsTitle')}</h3>
                    {participants?.invitations.length ? (
                      <ul className="divide-y divide-solid-gray-200 border border-solid-gray-300">
                        {participants.invitations.map((invitation) => (
                          <li key={invitation.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                            <div>
                              <p className="break-all font-bold">{invitation.email}</p>
                              <p className="text-dns-14N-130 text-solid-gray-600">
                                {t(`videos.courseMembers.status.${invitation.status}`)}{features.emailDelivery && <> / {t(`videos.courseMembers.delivery.${invitation.delivery_status}`)}</>}
                              </p>
                            </div>
                            {invitation.status === 'pending' ? (
                              <div className="flex gap-2">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  onClick={() => runOperation({ kind: 'resend', invitationId: invitation.id })}
                                  disabled={operation.isPending}
                                  aria-busy={resendingInvitationId === invitation.id}
                                >
                                  {resendingInvitationId === invitation.id ? <InlineSpinner className="h-4 w-4" /> : null}
                                  {t(features.emailDelivery ? 'videos.courseMembers.resend' : 'onprem.reissueCourseLink')}
                                </Button>
                                <Button
                                  type="button"
                                  variant="text"
                                  size="sm"
                                  onClick={() => runOperation({ kind: 'revoke', invitationId: invitation.id })}
                                  disabled={operation.isPending}
                                  aria-busy={revokingInvitationId === invitation.id}
                                >
                                  {revokingInvitationId === invitation.id ? <InlineSpinner className="h-4 w-4" /> : null}
                                  {t('videos.courseMembers.revoke')}
                                </Button>
                              </div>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : <p>{t('videos.courseMembers.noInvitations')}</p>}
                  </section>
                </>
              )}
            </div>
          </DialogBody>
        </DialogScrollArea>
        <DialogActions>
          <Button type="button" variant="outline" onClick={closeDialog} disabled={isInviting}>
            {t('common.actions.close')}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
