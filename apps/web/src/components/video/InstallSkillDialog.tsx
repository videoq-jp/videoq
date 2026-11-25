import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Copy, Terminal } from 'lucide-react';
import type { SkillView } from '@videoq/trpc/skills';
import { appTrpcClient, trpc } from '@/lib/trpc';
import { Link } from '@/lib/i18n';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { InlineSpinner } from '@/components/common/InlineSpinner';
import { Dialog, DialogActions, DialogBody, DialogContent, DialogHeader, DialogHeading, DialogScrollArea, useDialog } from '@/components/ui/dialog';
import { skillInstallCommand, type Agent } from '@/lib/skill-install';

const processing = (view: SkillView) => ['extracting', 'planning', 'synthesizing', 'auditing'].includes(view.stage);

export function InstallSkillDialog({ kind, resourceId, open, onOpenChange }: {
  kind: 'course' | 'video'; resourceId: number; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const storageKey = `videoq:skill-job:${kind}:${resourceId}`;
  const [savedId, setSavedId] = useState<string | null>(() => { try { return localStorage.getItem(storageKey); } catch { return null; } });
  const [view, setView] = useState<SkillView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const saved = useQuery({ ...trpc.skills.get.queryOptions({ id: savedId ?? '00000000-0000-4000-8000-000000000000' }), enabled: open && !!savedId && !view, retry: false });
  const active = view ?? saved.data ?? null;
  const [agent, setAgent] = useState<Agent>('both');
  const [global, setGlobal] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const dialog = useDialog({ open, onOpenChange, onRequestClose: event => { if (busy) event.preventDefault(); } });
  const command = active?.stage === 'published' ? skillInstallCommand(window.location.origin, active.id, agent, global) : '';
  const remember = (result: SkillView) => {
    setView(result); setSavedId(result.id);
    try { localStorage.setItem(storageKey, result.id); } catch { /* Server state remains available by ID. */ }
  };
  const generate = async (start: boolean) => {
    setBusy(true); setError(null); controller.current = new AbortController();
    const signal = controller.current.signal;
    try {
      let result = start ? await appTrpcClient.skills.start.mutate({ kind, resourceId, language: i18n.resolvedLanguage?.startsWith('ja') ? 'ja' : 'en' }, { signal })
        : await appTrpcClient.skills.get.query({ id: active!.id }, { signal });
      remember(result);
      while (processing(result)) {
        result = await appTrpcClient.skills.advance.mutate({ id: result.id }, { signal });
        remember(result);
      }
    } catch (failure) { setError(signal.aborted ? t('skills.paused') : failure instanceof Error ? failure.message : t('skills.failed')); }
    finally { setBusy(false); }
  };
  const publish = async () => {
    if (!active) return;
    setBusy(true); setError(null);
    try { remember(await appTrpcClient.skills.publish.mutate({ id: active.id })); }
    catch (failure) { setError(failure instanceof Error ? failure.message : t('skills.failed')); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopyState('copied'); }
    catch { setCopyState('error'); }
  };
  return (
    <Dialog {...dialog.dialogProps} scroll="inner" width="min(48rem, 92vw)">
      {open && <DialogContent>
        <DialogHeader><DialogHeading {...dialog.headingProps}>{t('skills.title')}</DialogHeading></DialogHeader>
        <DialogScrollArea><DialogBody>
          <div className="space-y-5">
            {!active && <p>{t('skills.description')}</p>}
            {!active && <div className="space-y-2">
              <p className="text-sm text-solid-gray-700">{t('skills.generationCost')}</p>
              <Button disabled={busy} onClick={() => void generate(true)}>{t('skills.generate')}</Button>
            </div>}
            {busy && <p className="text-sm text-solid-gray-700">{t('skills.keepOpen')}</p>}
            {saved.isLoading && !view && savedId ? <p role="status">{t('skills.loading')}</p> : null}
            {(error || saved.error) && <p role="alert" className="text-error-1">{error ?? saved.error?.message}</p>}
            {active && <div className="space-y-3">
              <div role="status" aria-live="polite" className="flex items-center gap-2">{busy && <InlineSpinner className="mr-2 inline h-4 w-4" />}{t(`skills.stages.${active.stage}`)}</div>
              {active.objective && <p className="text-sm">{active.objective}</p>}
              {active.members?.length ? <details className="space-y-3" open={processing(active) || active.stage === 'rejected' ? true : undefined}>
                <summary className="app-focus cursor-pointer font-bold">{t('skills.memberCount', { count: active.members.length })}</summary>
                {active.members.map((member, index) => <div key={index} className="space-y-2 rounded-4 border border-solid-gray-420 p-3">
                  <p className="font-bold">{member.title ?? member.objective}</p>
                  <p className="text-sm">{member.description ?? member.objective}</p>
                  <p className="text-sm">{t(member.status === 'pending' && member.issues.length ? 'skills.repairing' : `skills.memberStatuses.${member.status}`)}</p>
                  {member.issues.map((issue, i) => <p key={i} role="alert" className="text-error-1">{issue}</p>)}
                  {member.markdown && <details><summary className="app-focus cursor-pointer">{t('skills.preview')}</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">{member.markdown}</pre></details>}
                  {member.sourcesMarkdown && <details><summary className="app-focus cursor-pointer">{t('skills.evidence')}</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-sm">{member.sourcesMarkdown}</pre></details>}
                </div>)}
              </details> : null}
              {active.issues.map((issue, index) => <p key={index} role="alert" className="text-error-1">{issue}</p>)}
              {!busy && processing(active) && <Button onClick={() => void generate(false)}>{t('skills.resume')}</Button>}
              {active.markdown && <details open={active.stage === 'review'}>
                <summary className="app-focus cursor-pointer font-bold">{t('skills.preview')}</summary>
                <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-4 border border-solid-gray-420 bg-solid-gray-50 p-3 text-sm">{active.markdown}</pre>
              </details>}
              {active.sourcesMarkdown && <details><summary className="app-focus cursor-pointer font-bold">{t('skills.evidence')}</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-4 border border-solid-gray-420 p-3 text-sm">{active.sourcesMarkdown}</pre></details>}
              {active.stage === 'review' && <Button disabled={busy} onClick={() => void publish()}>{t('skills.publish')}</Button>}
            </div>}
            {active?.stage === 'published' && <div className="space-y-5 border-t border-solid-gray-420 pt-5">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${id}-agent`}>{t('skills.agent')}</Label>
                <select id={`${id}-agent`} value={agent} onChange={event => { setAgent(event.target.value as Agent); setCopyState('idle'); }} className="app-focus min-h-11 rounded-4 border border-solid-gray-600 bg-white px-3">
                  <option value="both">Codex + Claude Code</option><option value="codex">Codex</option><option value="claude">Claude Code</option>
                </select>
              </div>
              <label className="flex min-h-11 items-center gap-3"><input type="checkbox" checked={global} onChange={event => { setGlobal(event.target.checked); setCopyState('idle'); }} />{t('skills.global')}</label>
              <div className="space-y-3">
                <Label htmlFor={`${id}-command`}>{t(global ? 'skills.runGlobal' : 'skills.runProject')}</Label>
                <textarea id={`${id}-command`} readOnly aria-label={t('skills.command')} value={command} rows={2} className="app-focus w-full resize-none rounded-4 border border-solid-gray-420 bg-solid-gray-50 p-3 font-mono text-sm" onFocus={event => event.target.select()} />
                <Button variant="outline" onClick={() => void copy()}><Copy className="h-4 w-4" />{t(copyState === 'copied' ? 'skills.copied' : 'skills.copy')}</Button>
                <p role="status" className="text-sm">{copyState === 'error' ? t('skills.copyError') : ''}</p>
                <p className="text-sm">{t('skills.keyPrompt')} <Link href="/settings#api-keys-heading" className="underline">{t('skills.key')}</Link></p>
              </div>
              <p className="text-sm text-solid-gray-700">{t('skills.snapshot')}</p>
            </div>}
            <details className="text-sm text-solid-gray-700">
              <summary className="app-focus cursor-pointer">{t('skills.details')}</summary>
              <ul className="mt-2 list-disc space-y-2 pl-5">
                <li>{t('skills.requirements')}</li><li>{t('skills.limits')}</li>
                <li>{t('skills.usageDetails')}</li><li>{t('skills.updateDetails')}</li>
                {active?.stage === 'published' && <li>{t('skills.invoke')}</li>}
              </ul>
            </details>
          </div>
        </DialogBody></DialogScrollArea>
        <DialogActions>{active && <Button variant="text" disabled={busy} onClick={() => void generate(true)}>{t('skills.generateNew')}</Button>}{busy && (!active || processing(active)) && <Button variant="outline" onClick={() => controller.current?.abort()}>{t('skills.pause')}</Button>}<Button variant="outline" disabled={busy} {...dialog.closeButtonProps}>{t('common.actions.close')}</Button></DialogActions>
      </DialogContent>}
    </Dialog>
  );
}

export function InstallSkillButton({ kind, resourceId }: { kind: 'course' | 'video'; resourceId: number }) {
  const { t } = useTranslation(); const [open, setOpen] = useState(false);
  return <><Button variant="outline" size="sm" onClick={() => setOpen(true)}><Terminal className="h-4 w-4" />{t('skills.open')}</Button><InstallSkillDialog key={`${kind}-${resourceId}`} kind={kind} resourceId={resourceId} open={open} onOpenChange={setOpen} /></>;
}
