import { useId, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RpcInputMap, RpcOutputMap } from '@videoq/trpc';
import { appTrpcClient, trpc } from '@/lib/trpc';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ErrorMessage } from '@/components/auth/ErrorMessage';
import { LoadingSpinner } from '@/components/common/LoadingSpinner';
import { Dialog, DialogContent, DialogHeader, DialogHeading, DialogBody, DialogScrollArea, DialogActions, useDialog } from '@/components/ui/dialog';

type Draft = NonNullable<RpcOutputMap['courseSkills.get']['draft']>;
type Settings = RpcInputMap['courseSkills.configure']['settings'];
type Command = { kind: 'configure'; settings: Settings } | { kind: 'rebuild' } | { kind: 'withdraw'; skillId: string }
  | { kind: 'publish' | 'reject'; candidateId: string; expectedHash: string }
  | { kind: 'update'; candidateId: string; expectedHash: string; draft: Draft };

function SkillEditor({ detail, busy, editable, canPublish, onSave, onPublish, onReject, onPlay }: {
  detail: RpcOutputMap['courseSkills.get']; busy: boolean; editable: boolean; canPublish: boolean;
  onSave: (draft: Draft) => void; onPublish: () => void; onReject: () => void; onPlay?: (videoId: number, startTime: string) => void;
}) {
  const { t } = useTranslation();
  const prefix = useId();
  const [draft, setDraft] = useState(detail.draft);
  const edited = JSON.stringify(draft) !== JSON.stringify(detail.draft);
  const published = detail.status === 'published';
  const timestamp = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  return <section className="space-y-5 border-t border-solid-gray-300 pt-5" aria-label={t('courseSkills.review')}>
    <h3 className="text-std-20B-160">{t('courseSkills.review')}</h3>
    {detail.issues.length ? <div role="status" className="rounded border border-yellow-700 bg-yellow-50 p-3"><p className="font-bold">{t('courseSkills.needsReview')}</p><ul className="list-disc pl-5">{detail.issues.map((issue, i) => <li key={i}>{issue.startsWith('SKILL_') ? t(`courseSkills.issues.${issue}`, { defaultValue: t('courseSkills.issueFallback') }) : issue}</li>)}</ul></div> : null}
    {detail.previousDraft ? <details className="rounded border border-solid-gray-300 p-3"><summary className="cursor-pointer font-bold">{t('courseSkills.previous')}</summary><div className="mt-3 space-y-2"><h4 className="font-bold">{detail.previousDraft.title}</h4><p>{detail.previousDraft.description}</p><ol className="list-decimal pl-5">{detail.previousDraft.steps.map((step, i) => <li key={i}>{step.action} — {step.expectedResult}</li>)}</ol></div></details> : null}
    {detail.changes ? <details className="rounded border border-solid-gray-300 p-3" open><summary className="cursor-pointer font-bold">{t('courseSkills.changes')}</summary><div className="mt-3 space-y-3">{(['addedKnowledge', 'removedKnowledge'] as const).map(kind => <div key={kind}><h4 className="font-bold">{t(`courseSkills.${kind}`)}</h4>{detail.changes![kind].length ? <ul className="list-disc pl-5">{detail.changes![kind].map((claim, i) => <li key={i}>{claim}</li>)}</ul> : <p>{t('courseSkills.noChanges')}</p>}</div>)}{(['addedVideos', 'removedVideos'] as const).map(kind => <div key={kind}><h4 className="font-bold">{t(`courseSkills.${kind}`)}</h4><p>{detail.changes![kind].map(id => t('courseSkills.video', { id })).join(', ') || t('courseSkills.noChanges')}</p></div>)}</div></details> : null}
    {draft ? <fieldset disabled={busy || published || !editable} className="space-y-4">
      <legend className="mb-3 font-bold">{t('courseSkills.proposed')}</legend>
      <div className="space-y-1"><Label htmlFor={`${prefix}-title`}>{t('courseSkills.name')}</Label><Input id={`${prefix}-title`} value={draft.title} onChange={e => setDraft({ ...draft, title: e.currentTarget.value })} /></div>
      <div className="space-y-1"><Label htmlFor={`${prefix}-description`}>{t('courseSkills.description')}</Label><Textarea id={`${prefix}-description`} value={draft.description} onChange={e => setDraft({ ...draft, description: e.currentTarget.value })} /></div>
      <div className="space-y-3">{(['useWhen', 'doNotUseWhen'] as const).map(kind => draft[kind].map((text, i) => <div key={`${kind}-${i}`} className="space-y-1"><Label htmlFor={`${prefix}-${kind}-${i}`}>{t(kind === 'useWhen' ? 'courseSkills.applicability' : 'courseSkills.exclusions')} {i + 1}</Label><Textarea id={`${prefix}-${kind}-${i}`} value={text} onChange={e => setDraft({ ...draft, [kind]: draft[kind].map((value, n) => n === i ? e.currentTarget.value : value) })} /></div>))}</div>
      {draft.criteria.map((criterion, i) => <div key={i} className="space-y-1"><Label htmlFor={`${prefix}-criterion-${i}`}>{t('courseSkills.criterion', { number: i + 1 })}</Label><Textarea id={`${prefix}-criterion-${i}`} value={criterion.decision} onChange={e => setDraft({ ...draft, criteria: draft.criteria.map((x, n) => n === i ? { ...x, decision: e.currentTarget.value } : x) })} /></div>)}
      {draft.steps.map((step, i) => <div key={i} className="space-y-2 rounded border border-solid-gray-200 p-3"><Label htmlFor={`${prefix}-step-${i}`}>{t('courseSkills.step', { number: i + 1 })}</Label><Textarea id={`${prefix}-step-${i}`} value={step.action} onChange={e => setDraft({ ...draft, steps: draft.steps.map((x, n) => n === i ? { ...x, action: e.currentTarget.value } : x) })} /><Label htmlFor={`${prefix}-result-${i}`}>{t('courseSkills.expected', { number: i + 1 })}</Label><Textarea id={`${prefix}-result-${i}`} value={step.expectedResult} onChange={e => setDraft({ ...draft, steps: draft.steps.map((x, n) => n === i ? { ...x, expectedResult: e.currentTarget.value } : x) })} /></div>)}
      {draft.exceptions.map((exception, i) => <div key={i} className="space-y-2 rounded border border-solid-gray-200 p-3"><Label htmlFor={`${prefix}-exception-${i}`}>{t('courseSkills.exceptionCondition')} {i + 1}</Label><Textarea id={`${prefix}-exception-${i}`} value={exception.condition} onChange={e => setDraft({ ...draft, exceptions: draft.exceptions.map((value, n) => n === i ? { ...value, condition: e.currentTarget.value } : value) })} /><Label htmlFor={`${prefix}-behavior-${i}`}>{t('courseSkills.exceptionBehavior')} {i + 1}</Label><Textarea id={`${prefix}-behavior-${i}`} value={exception.behavior} onChange={e => setDraft({ ...draft, exceptions: draft.exceptions.map((value, n) => n === i ? { ...value, behavior: e.currentTarget.value } : value) })} /></div>)}
      {draft.checks.map((check, i) => <div key={i} className="space-y-1"><Label htmlFor={`${prefix}-check-${i}`}>{t('courseSkills.check', { number: i + 1 })}</Label><Textarea id={`${prefix}-check-${i}`} value={check.check} onChange={e => setDraft({ ...draft, checks: draft.checks.map((x, n) => n === i ? { ...x, check: e.currentTarget.value } : x) })} /></div>)}
      {draft.examples.map((example, i) => <div key={i} className="space-y-2 rounded border border-solid-gray-200 p-3"><Label htmlFor={`${prefix}-situation-${i}`}>{t('courseSkills.exampleSituation')} {i + 1}</Label><Textarea id={`${prefix}-situation-${i}`} value={example.situation} onChange={e => setDraft({ ...draft, examples: draft.examples.map((value, n) => n === i ? { ...value, situation: e.currentTarget.value } : value) })} /><Label htmlFor={`${prefix}-application-${i}`}>{t('courseSkills.exampleApplication')} {i + 1}</Label><Textarea id={`${prefix}-application-${i}`} value={example.application} onChange={e => setDraft({ ...draft, examples: draft.examples.map((value, n) => n === i ? { ...value, application: e.currentTarget.value } : value) })} /><Button variant="text" size="sm" onClick={() => setDraft({ ...draft, examples: draft.examples.filter((_, n) => n !== i) })}>{t('courseSkills.removeExample')}</Button></div>)}
    </fieldset> : <p>{t('courseSkills.insufficient')}</p>}
    <details className="rounded border border-solid-gray-300 p-3" open><summary className="cursor-pointer font-bold">{t('courseSkills.sources')}</summary><ul className="mt-3 space-y-4">{detail.sources.map((source, i) => <li key={`${source.factId}-${i}`} className="border-l-2 border-solid-gray-300 pl-3"><p className="font-bold">{source.claim}</p><p>{t('courseSkills.video', { id: source.videoId })} · {timestamp(source.startMs)}–{timestamp(source.endMs)}{source.kind === 'image' ? ` · ${t('courseSkills.imageSource')}` : ''}</p><blockquote className="whitespace-pre-wrap text-solid-gray-700">{source.quote}</blockquote>{onPlay ? <Button variant="text" size="sm" onClick={() => onPlay(source.videoId, String(source.startMs / 1000))} disabled={busy}>{t('courseSkills.playSource')}</Button> : null}</li>)}</ul></details>
    <div className="flex flex-wrap gap-3">
      {draft && !published ? <Button variant="outline" disabled={busy || !edited || !editable} onClick={() => onSave(draft)}>{t('courseSkills.save')}</Button> : null}
      {!published ? <Button disabled={busy || edited || !canPublish} onClick={onPublish}>{t('courseSkills.publish')}</Button> : null}
      {!published ? <Button variant="text" disabled={busy || !editable} onClick={onReject}>{t('courseSkills.reject')}</Button> : null}
    </div>
    {edited ? <p role="status" className="text-solid-gray-700">{t('courseSkills.saveBeforePublish')}</p> : null}
  </section>;
}

export function CourseSkillsDialog({ courseId, isOpen, onOpenChange, onPlay }: {
  courseId: number; isOpen: boolean; onOpenChange: (open: boolean) => void; onPlay?: (videoId: number, startTime: string) => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const id = useId();
  const [settingsDraft, setSettingsDraft] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const list = useQuery({ ...trpc.courseSkills.list.queryOptions({ courseId }), enabled: isOpen,
    // Reconciliation can enqueue a build after the previous job has completed.
    refetchInterval: query => !isOpen ? false : query.state.data?.jobs.some(j => ['queued', 'running'].includes(j.state)) ? 3000 : 15000 });
  const detail = useQuery({ ...trpc.courseSkills.get.queryOptions({ courseId, candidateId: selected ?? 'none' }), enabled: isOpen && selected !== null });
  const operation = useMutation({
    mutationFn: async (command: Command) => {
      switch (command.kind) {
        case 'configure': return appTrpcClient.courseSkills.configure.mutate({ courseId, settings: command.settings });
        case 'rebuild': return appTrpcClient.courseSkills.rebuild.mutate({ courseId });
        case 'withdraw': return appTrpcClient.courseSkills.withdraw.mutate({ courseId, skillId: command.skillId });
        case 'publish': return appTrpcClient.courseSkills.publish.mutate({ courseId, candidateId: command.candidateId, expectedHash: command.expectedHash });
        case 'reject': return appTrpcClient.courseSkills.reject.mutate({ courseId, candidateId: command.candidateId, expectedHash: command.expectedHash });
        case 'update': return appTrpcClient.courseSkills.update.mutate({ courseId, candidateId: command.candidateId, expectedHash: command.expectedHash, draft: command.draft });
      }
    },
    onSuccess: async (_result, command) => {
      if (command.kind === 'configure') setSettingsDraft(null);
      await queryClient.invalidateQueries({ queryKey: trpc.courseSkills.list.queryKey({ courseId }) });
      if (selected) await queryClient.invalidateQueries({ queryKey: trpc.courseSkills.get.queryKey({ courseId, candidateId: selected }) });
    },
  });
  const dialog = useDialog({ open: isOpen, onOpenChange: open => { if (!open) closeDialog(); }, onRequestClose: e => { if (operation.isPending) e.preventDefault(); } });
  const closeDialog = () => { if (operation.isPending) return; dialog.dialogProps.ref.current?.close(); onOpenChange(false); };
  const settings = settingsDraft ?? list.data?.settings;
  const reviewed = detail.data;
  const selectedSummary = list.data?.candidates.find(c => c.id === selected);
  const replacement = reviewed && list.data?.candidates.find(c => c.skillId === reviewed.skillId && c.id !== reviewed.id);
  const label = (state: string) => t(`courseSkills.states.${state}`, { defaultValue: t('courseSkills.states.unknown') });
  return <Dialog {...dialog.dialogProps} scroll="inner" width="min(58rem, 95vw)"><DialogContent>
    <DialogHeader><DialogHeading {...dialog.headingProps}>{t('courseSkills.title')}</DialogHeading></DialogHeader>
    {operation.error ? <div className="px-4 md:px-6"><ErrorMessage message={operation.error.message} /></div> : null}
    <DialogScrollArea><DialogBody><div className="space-y-6">
      <p>{t('courseSkills.intro')}</p>
      {list.isLoading ? <LoadingSpinner /> : list.error ? <ErrorMessage message={list.error.message} /> : settings ? <>
        <fieldset disabled={operation.isPending} className="space-y-3 rounded border border-solid-gray-300 p-4"><legend className="px-1 font-bold">{t('courseSkills.settings')}</legend>
          <div className="flex items-start gap-2"><input id={`${id}-generation`} type="checkbox" className="mt-1 h-5 w-5" checked={settings.generationEnabled} onChange={e => setSettingsDraft({ ...settings, generationEnabled: e.currentTarget.checked })} /><Label htmlFor={`${id}-generation`}>{t('courseSkills.generation')}</Label></div>
          <p className="text-solid-gray-700">{t('courseSkills.quota')}</p>
          <div className="flex items-start gap-2"><input id={`${id}-distribution`} type="checkbox" className="mt-1 h-5 w-5" checked={settings.distributionEnabled} onChange={e => setSettingsDraft({ ...settings, distributionEnabled: e.currentTarget.checked })} /><Label htmlFor={`${id}-distribution`}>{t('courseSkills.distribution')}</Label></div>
          <div className="flex items-center gap-3"><Label htmlFor={`${id}-language`}>{t('courseSkills.language')}</Label><select id={`${id}-language`} className="rounded border border-solid-gray-600 bg-white p-2" value={settings.language} onChange={e => setSettingsDraft({ ...settings, language: e.currentTarget.value === 'en' ? 'en' : 'ja' })}><option value="ja">日本語</option><option value="en">English</option></select></div>
          <Button variant="outline" disabled={!settingsDraft || operation.isPending} onClick={() => operation.mutate({ kind: 'configure', settings })}>{t('courseSkills.saveSettings')}</Button>
        </fieldset>
        <div className="flex flex-wrap gap-3"><Button variant="outline" disabled={operation.isPending || !list.data?.settings.generationEnabled} onClick={() => operation.mutate({ kind: 'rebuild' })}>{t('courseSkills.rebuild')}</Button><Button variant="text" disabled={list.isFetching} onClick={() => { void list.refetch(); }}>{t('courseSkills.refresh')}</Button></div>
        {list.data?.jobs[0] ? <div role="status" className="rounded bg-solid-gray-50 p-3"><p className="font-bold">{t('courseSkills.progress')}</p><p>{label(list.data.jobs[0].state)} · {label(list.data.jobs[0].phase)} · {list.data.jobs[0].processedVideos}/{list.data.jobs[0].totalVideos} {t('courseSkills.videos')}</p>{list.data.jobs[0].error ? <p>{t(`courseSkills.issues.${list.data.jobs[0].error}`, { defaultValue: t('courseSkills.generationError') })}</p> : null}</div> : null}
        <section className="space-y-3"><h3 className="text-std-20B-160">{t('courseSkills.skills')}</h3>{list.data?.candidates.length ? <ul className="divide-y divide-solid-gray-200 rounded border border-solid-gray-300">{list.data.candidates.map(candidate => <li key={candidate.id} className="space-y-2 p-4"><h4 className="font-bold">{candidate.title}</h4><p>{candidate.description}</p><p>{candidate.publication ? label(!candidate.publication.validSources && candidate.publication.state !== 'revoked' ? 'suspended' : candidate.publication.state) : label(candidate.status)}</p>{candidate.publication && !candidate.publication.validSources ? <p className="text-solid-gray-700">{t('courseSkills.sourceRemoved')}</p> : null}<div className="flex flex-wrap gap-3"><Button variant="outline" size="sm" disabled={operation.isPending} onClick={() => setSelected(candidate.id)} aria-pressed={selected === candidate.id}>{t('courseSkills.review')}</Button>{candidate.publication && candidate.publication.state !== 'revoked' ? <Button variant="text" size="sm" disabled={operation.isPending} onClick={() => operation.mutate({ kind: 'withdraw', skillId: candidate.skillId })}>{t('courseSkills.withdraw')}</Button> : null}</div></li>)}</ul> : <p>{t('courseSkills.empty')}</p>}</section>
      </> : null}
      {selected && detail.isLoading ? <LoadingSpinner /> : null}
      {detail.error ? <ErrorMessage message={detail.error.message} /> : null}
      {reviewed && list.data && !selectedSummary ? <div role="status" className="space-y-3 rounded border border-yellow-700 bg-yellow-50 p-3"><p>{t('courseSkills.candidateSuperseded')}</p>{replacement ? <Button variant="outline" disabled={operation.isPending} onClick={() => setSelected(replacement.id)}>{t('courseSkills.reviewLatest')}</Button> : null}</div> : null}
      {reviewed ? <SkillEditor key={`${reviewed.id}:${reviewed.contentHash}`} detail={reviewed} busy={operation.isPending} editable={selectedSummary?.editable ?? false} canPublish={selectedSummary?.canPublish ?? false}
        onSave={draft => operation.mutate({ kind: 'update', candidateId: reviewed.id, expectedHash: reviewed.contentHash, draft })}
        onPublish={() => operation.mutate({ kind: 'publish', candidateId: reviewed.id, expectedHash: reviewed.contentHash })}
        onReject={() => operation.mutate({ kind: 'reject', candidateId: reviewed.id, expectedHash: reviewed.contentHash })}
        onPlay={onPlay ? (videoId, startTime) => { closeDialog(); onPlay(videoId, startTime); } : undefined} /> : null}
    </div></DialogBody></DialogScrollArea>
    <DialogActions><Button variant="outline" disabled={operation.isPending} onClick={closeDialog}>{t('common.actions.close')}</Button></DialogActions>
  </DialogContent></Dialog>;
}
