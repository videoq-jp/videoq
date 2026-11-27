import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { RpcOutputMap } from '@videoq/trpc';
import { CourseSkillsDialog } from '../CourseSkillsDialog';

let list: RpcOutputMap['courseSkills.list'];
let detail: RpcOutputMap['courseSkills.get'];
const handlers = { configure: vi.fn(), rebuild: vi.fn(), update: vi.fn(), publish: vi.fn(), reject: vi.fn(), withdraw: vi.fn() };
const props = () => ({ courseId: 7, isOpen: true, onOpenChange: vi.fn(), onPlay: vi.fn() });
const button = (key: string) => screen.getByRole('button', { name: `courseSkills.${key}` });
async function review() { fireEvent.click(await screen.findByRole('button', { name: 'courseSkills.review' })); await screen.findByLabelText('courseSkills.name'); }

beforeEach(() => {
  for (const fn of Object.values(handlers)) fn.mockReset().mockResolvedValue({ success: true });
  detail = { id: 'candidate', skillId: 'skill', contentHash: 'a'.repeat(64), status: 'review_required', issues: [], previousDraft: null, files: [],
    draft: { slug: 'review-retry', title: 'Review retries', description: 'Review retry guarantees', useWhen: ['Changing retries'], doNotUseWhen: ['Different policy'], criteria: [{ decision: 'Check guarantees', factIds: ['f'] }], steps: [{ action: 'Inspect code', expectedResult: 'Known guarantees', factIds: ['f'] }], exceptions: [], checks: [{ check: 'Repeat request', factIds: ['f'] }], examples: [] },
    changes: { addedKnowledge: ['Keep retry guarantees'], removedKnowledge: ['Removed advice'], addedVideos: [42], removedVideos: [41] },
    sources: [{ factId: 'f', claim: 'Keep retry guarantees', videoId: 42, startMs: 12500, endMs: 15000, quote: 'Use the same request ID', kind: 'subtitle' }, { factId: 'f', claim: 'Shown code', videoId: 42, startMs: 13000, endMs: 13000, quote: 'Request ID is visible', kind: 'image' }] };
  list = { settings: { generationEnabled: true, distributionEnabled: true, language: 'ja', policyVersion: '1' }, revision: 1,
    candidates: [{ id: detail.id, skillId: detail.skillId, title: detail.draft!.title, description: detail.draft!.description, status: detail.status, contentHash: detail.contentHash, issues: [], hasDraft: true, editable: true, canPublish: true, publication: null }],
    jobs: [{ id: 'build', revision: 1, state: 'completed', phase: 'review_required', processedVideos: 1, totalVideos: 1, error: null }] };
  globalThis.__setTrpcHandler('courseSkills.list', async () => structuredClone(list));
  globalThis.__setTrpcHandler('courseSkills.get', async () => structuredClone(detail));
  for (const key of ['configure', 'rebuild', 'update', 'publish', 'reject', 'withdraw'] as const) globalThis.__setTrpcHandler(`courseSkills.${key}`, handlers[key]);
});

describe('course skill owner review', () => {
  it('shows review evidence and disables publication when details fail current checks despite a stale list', async () => {
    detail.issues = ['SKILL_INVALID_VISUAL_EVIDENCE'];
    render(<CourseSkillsDialog {...props()} />);
    await review();
    expect(screen.getByText('Shown code')).toBeInTheDocument();
    expect(button('publish')).toBeDisabled();
    fireEvent.click(button('reject'));
    await waitFor(() => expect(handlers.reject).toHaveBeenCalledWith(expect.objectContaining({ candidateId: 'candidate', expectedHash: detail.contentHash })));
    expect(handlers.publish).not.toHaveBeenCalled();
  });
  it('detects background builds after completed jobs and stops polling when closed', async () => {
    const read = vi.fn(async () => structuredClone(list));
    globalThis.__setTrpcHandler('courseSkills.list', read);
    vi.useFakeTimers();
    const p = props();
    const view = render(<CourseSkillsDialog {...p} />);
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(read).toHaveBeenCalledTimes(1);
      list.jobs[0] = { ...list.jobs[0], id: 'next-build', revision: 2, state: 'running', totalVideos: 2 };
      await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(read).toHaveBeenCalledTimes(2);
      list.jobs[0].state = 'completed';
      list.candidates[0].title = 'Automatically refreshed candidate';
      await act(async () => { await vi.advanceTimersByTimeAsync(3001); });
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(screen.getByText('Automatically refreshed candidate')).toBeInTheDocument();
      view.rerender(<CourseSkillsDialog {...p} isOpen={false} />);
      const calls = read.mock.calls.length;
      await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
      expect(read).toHaveBeenCalledTimes(calls);
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });
  it('requires saving edits, publishes the new reviewed hash, then locks the published content', async () => {
    handlers.update.mockImplementation(async input => { detail.draft = input.draft; detail.contentHash = 'b'.repeat(64); list.candidates[0].contentHash = detail.contentHash; return { success: true }; });
    handlers.publish.mockImplementation(async () => { detail.status = 'published'; list.candidates[0].status = 'published'; list.candidates[0].canPublish = false; list.candidates[0].publication = { id: 'publication', state: 'active', validSources: true }; return { revisionId: 'publication' }; });
    render(<CourseSkillsDialog {...props()} />); await review();
    expect(screen.getByText('Removed advice')).toBeInTheDocument();
    expect(screen.getByText(/courseSkills.imageSource/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('courseSkills.name'), { target: { value: 'Check retries before changes' } });
    fireEvent.change(screen.getByLabelText('courseSkills.description'), { target: { value: 'Review retry guarantees before editing code' } });
    expect(button('publish')).toBeDisabled();
    fireEvent.click(button('save'));
    await waitFor(() => expect(button('publish')).toBeEnabled());
    expect(handlers.update).toHaveBeenCalledWith(expect.objectContaining({ expectedHash: 'a'.repeat(64), draft: expect.objectContaining({ title: 'Check retries before changes' }) }));
    fireEvent.click(button('publish'));
    await screen.findByText('courseSkills.states.active');
    expect(handlers.publish).toHaveBeenCalledWith({ courseId: 7, candidateId: 'candidate', expectedHash: 'b'.repeat(64) });
    await waitFor(() => expect(screen.getByLabelText('courseSkills.name')).toBeDisabled());
  });
  it('saves distribution settings independently and offers explicit rebuilding', async () => {
    const p = props(); render(<CourseSkillsDialog {...p} />);
    const distribution = await screen.findByLabelText('courseSkills.distribution');
    fireEvent.click(distribution); fireEvent.click(button('saveSettings'));
    await waitFor(() => expect(handlers.configure).toHaveBeenCalledWith({ courseId: 7, settings: { ...list.settings, distributionEnabled: false } }));
    expect(handlers.rebuild).not.toHaveBeenCalled();
    await waitFor(() => expect(button('rebuild')).toBeEnabled()); fireEvent.click(button('rebuild'));
    await waitFor(() => expect(handlers.rebuild).toHaveBeenCalledWith({ courseId: 7 }));
  });
  it('shows stopped distribution after source removal and allows withdrawal', async () => {
    detail.status = 'published'; list.candidates[0].status = 'published'; list.candidates[0].editable = false; list.candidates[0].canPublish = false;
    list.candidates[0].publication = { id: 'publication', state: 'active', validSources: false };
    render(<CourseSkillsDialog {...props()} />);
    await screen.findByText('courseSkills.states.suspended'); expect(screen.getByText('courseSkills.sourceRemoved')).toBeInTheDocument();
    fireEvent.click(button('withdraw')); await waitFor(() => expect(handlers.withdraw).toHaveBeenCalledWith({ courseId: 7, skillId: 'skill' }));
    await waitFor(() => expect(button('review')).toBeEnabled()); await review();
    expect(screen.getByLabelText('courseSkills.name')).toBeDisabled(); expect(screen.queryByRole('button', { name: 'courseSkills.publish' })).not.toBeInTheDocument();
  });
  it('keeps unsaved changes when a concurrent update rejects saving', async () => {
    handlers.update.mockRejectedValue(new Error('Candidate changed; reload'));
    render(<CourseSkillsDialog {...props()} />); await review();
    fireEvent.change(screen.getByLabelText('courseSkills.name'), { target: { value: 'My pending edit' } }); fireEvent.click(button('save'));
    await screen.findByText('Candidate changed; reload'); expect(screen.getByLabelText('courseSkills.name')).toHaveValue('My pending edit'); expect(button('publish')).toBeDisabled();
  });
  it('explains a replaced candidate, preserves pending edits and opens the latest version explicitly', async () => {
    globalThis.__setTrpcHandler('courseSkills.get', async input => {
      const id = (input as { candidateId: string }).candidateId;
      return id === 'replacement' ? { ...structuredClone(detail), id, contentHash: 'b'.repeat(64), draft: { ...detail.draft!, title: 'Latest candidate' } } : structuredClone(detail);
    });
    render(<CourseSkillsDialog {...props()} />); await review();
    fireEvent.change(screen.getByLabelText('courseSkills.name'), { target: { value: 'My pending correction' } });
    list.candidates[0] = { ...list.candidates[0], id: 'replacement', title: 'Latest candidate', contentHash: 'b'.repeat(64) };
    fireEvent.click(button('refresh'));
    await screen.findByText('courseSkills.candidateSuperseded');
    expect(screen.getByLabelText('courseSkills.name')).toHaveValue('My pending correction');
    expect(button('publish')).toBeDisabled(); expect(button('save')).toBeDisabled();
    expect(handlers.update).not.toHaveBeenCalled(); expect(handlers.publish).not.toHaveBeenCalled();
    fireEvent.click(button('reviewLatest'));
    await waitFor(() => expect(screen.getByLabelText('courseSkills.name')).toHaveValue('Latest candidate'));
    expect(button('publish')).toBeEnabled();
    expect(screen.queryByText('courseSkills.candidateSuperseded')).not.toBeInTheDocument();
  });
  it('closes before seeking to the exact evidence time', async () => {
    const p = props(); render(<CourseSkillsDialog {...p} />); await review(); fireEvent.click(screen.getAllByRole('button', { name: 'courseSkills.playSource' })[0]);
    expect(p.onOpenChange).toHaveBeenCalledWith(false); expect(p.onPlay).toHaveBeenCalledWith(42, '12.5');
  });
  it('does not allow review actions until generation has completed', async () => {
    list.candidates[0].editable = false; list.candidates[0].canPublish = false;
    render(<CourseSkillsDialog {...props()} />); await review();
    expect(screen.getByLabelText('courseSkills.name')).toBeDisabled(); expect(button('publish')).toBeDisabled(); expect(button('reject')).toBeDisabled();
  });
  it('rejects the exact reviewed candidate and reports loading failures', async () => {
    render(<CourseSkillsDialog {...props()} />); await review(); fireEvent.click(button('reject'));
    await waitFor(() => expect(handlers.reject).toHaveBeenCalledWith({ courseId: 7, candidateId: 'candidate', expectedHash: 'a'.repeat(64) }));
  });
  it('saves generation and language changes and disables rebuilding when generation is off', async () => {
    handlers.configure.mockImplementation(async input => { list.settings = input.settings; return { success: true }; });
    render(<CourseSkillsDialog {...props()} />);
    fireEvent.click(await screen.findByLabelText('courseSkills.generation'));
    fireEvent.change(screen.getByLabelText('courseSkills.language'), { target: { value: 'en' } });
    fireEvent.click(button('saveSettings'));
    await waitFor(() => expect(handlers.configure).toHaveBeenCalledWith({ courseId: 7, settings: { generationEnabled: false, distributionEnabled: true, language: 'en', policyVersion: '1' } }));
    await waitFor(() => expect(button('rebuild')).toBeDisabled());
  });
  it('explains held knowledge instead of offering publication', async () => {
    detail.draft = null; detail.issues = ['SKILL_INSUFFICIENT_TASK_KNOWLEDGE']; list.candidates[0].hasDraft = false; list.candidates[0].canPublish = false;
    render(<CourseSkillsDialog {...props()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'courseSkills.review' }));
    await screen.findByText('courseSkills.insufficient');
    expect(button('publish')).toBeDisabled(); expect(screen.queryByRole('button', { name: 'courseSkills.save' })).not.toBeInTheDocument();
  });
  it('reports a loading failure without offering settings or publication', async () => {
    globalThis.__setTrpcHandler('courseSkills.list', async () => { throw new Error('Could not read course skills'); });
    render(<CourseSkillsDialog {...props()} />);
    await screen.findByText('Could not read course skills');
    expect(screen.queryByRole('button', { name: 'courseSkills.saveSettings' })).not.toBeInTheDocument();
  });

  it('lets the owner correct applicability and exceptions and remove an inferred example before review', async () => {
    detail.draft!.exceptions = [{ condition: 'External side effect', behavior: 'Check provider guarantees', factIds: ['f'] }];
    detail.draft!.examples = [{ situation: 'Generated order example', application: 'Generated application', factIds: ['f'] }];
    render(<CourseSkillsDialog {...props()} />); await review();
    for (const [label, value] of [
      ['courseSkills.applicability 1', 'Database-only changes'], ['courseSkills.exclusions 1', 'External policy takes precedence'],
      ['courseSkills.exceptionCondition 1', 'External provider call'], ['courseSkills.exceptionBehavior 1', 'Use the provider idempotency guarantee'],
      ['courseSkills.exampleSituation 1', 'Inferred example'], ['courseSkills.exampleApplication 1', 'Remove until its source is verified'],
    ]) fireEvent.change(screen.getByLabelText(label), { target: { value } });
    fireEvent.click(button('removeExample')); expect(screen.queryByLabelText('courseSkills.exampleSituation 1')).not.toBeInTheDocument();
    fireEvent.click(button('save'));
    await waitFor(() => expect(handlers.update).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining({ useWhen: ['Database-only changes'], doNotUseWhen: ['External policy takes precedence'], examples: [], exceptions: [{ condition: 'External provider call', behavior: 'Use the provider idempotency guarantee', factIds: ['f'] }] }) })));
  });

});
