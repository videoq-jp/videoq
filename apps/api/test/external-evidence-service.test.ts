import { expect, it, vi } from 'vitest';
import { executeExternalEvidence, externalEvidencePlan, type ExternalEvidenceDependencies, type ExternalEvidenceExecution } from '../src/features/evidence/external-service';

const course = { id: 3, userId: 'owner', memberVideoIds: [42] };
const reservation = { userId: 'owner', usagePeriodStart: 'period', planCode: 'paid', quotaSource: 'subscription' };
const input = { courseId: 3, tool: 'search_scenes', args: { query: 'topic' } };
function fixture() {
  const invoke = vi.fn(async () => 'evidence');
  const execution = {
    startLedger: vi.fn<ExternalEvidenceExecution['startLedger']>().mockResolvedValue(),
    findTool: vi.fn<ExternalEvidenceExecution['findTool']>().mockReturnValue(invoke),
    interrupted: vi.fn(() => false), abort: vi.fn(), close: vi.fn(async () => {}),
    providerCalls: vi.fn<ExternalEvidenceExecution['providerCalls']>().mockReturnValue([]), finishLedger: vi.fn<ExternalEvidenceExecution['finishLedger']>().mockResolvedValue(),
  } satisfies ExternalEvidenceExecution;
  const deps = {
    readThrottle: vi.fn<ExternalEvidenceDependencies['readThrottle']>().mockResolvedValue(null),
    course: vi.fn<ExternalEvidenceDependencies['course']>().mockResolvedValue(course), checkCancellation: vi.fn(),
    evidenceThrottle: vi.fn<ExternalEvidenceDependencies['evidenceThrottle']>().mockResolvedValue(null),
    reserve: vi.fn<ExternalEvidenceDependencies['reserve']>().mockResolvedValue({ reservation }),
    release: vi.fn<ExternalEvidenceDependencies['release']>().mockResolvedValue(),
    open: vi.fn(() => execution), reportFailure: vi.fn(),
  } satisfies ExternalEvidenceDependencies;
  return { deps, execution, invoke };
}

it.each([
  { tool: 'read_video_window', args: {}, paid: false, cost: 1 },
  { tool: 'search_scenes', args: {}, paid: true, cost: 1 },
  { tool: 'inspect_clip', args: { include_visuals: false }, paid: true, cost: 8 },
  { tool: 'focus_clip', args: {}, paid: true, cost: 16 },
  { tool: 'overview_video', args: { include_visuals: true }, paid: true, cost: 16 },
  { tool: 'overview_video', args: { include_visuals: false }, paid: false, cost: 1 },
  { tool: 'read_video_window', args: { include_visuals: true }, paid: true, cost: 8 },
])('keeps external account cost for $tool ($paid, $cost)', ({ tool, args, paid, cost }) => {
  expect(externalEvidencePlan(tool, args)).toEqual({ paid, cost });
});

it('rejects read throttling before course lookup and cancellation checks', async () => {
  const { deps } = fixture(); deps.readThrottle.mockResolvedValue({ retryAfterSec: 12 });
  expect(await executeExternalEvidence(deps, input)).toEqual({ status: 'rate_limited', retry_after_seconds: 12 });
  expect(deps.course).not.toHaveBeenCalled(); expect(deps.checkCancellation).not.toHaveBeenCalled(); expect(deps.open).not.toHaveBeenCalled();
});

it('checks cancellation after the scoped course read, before unavailable-course handling', async () => {
  const { deps } = fixture(), error = new Error('cancelled'); deps.course.mockResolvedValue(null);
  deps.checkCancellation.mockImplementation(() => { expect(deps.course).toHaveBeenCalledWith(3); throw error; });
  await expect(executeExternalEvidence(deps, input)).rejects.toBe(error);
  expect(deps.reserve).not.toHaveBeenCalled(); expect(deps.open).not.toHaveBeenCalled();
});

it('rejects inaccessible courses before weighted throttling or account quota', async () => {
  const { deps } = fixture(); deps.course.mockResolvedValue(null);
  expect(await executeExternalEvidence(deps, input)).toMatchObject({ status: 'unavailable' });
  expect(deps.evidenceThrottle).not.toHaveBeenCalled(); expect(deps.reserve).not.toHaveBeenCalled();
});

it('applies weighted throttling before reserving an account unit or opening a provider session', async () => {
  const { deps } = fixture(); deps.evidenceThrottle.mockResolvedValue({ retryAfterSec: 7 });
  expect(await executeExternalEvidence(deps, { ...input, tool: 'focus_clip' })).toEqual({ status: 'rate_limited', retry_after_seconds: 7 });
  expect(deps.evidenceThrottle).toHaveBeenCalledExactlyOnceWith(16);
  expect(deps.reserve).not.toHaveBeenCalled(); expect(deps.open).not.toHaveBeenCalled();
});

it.each([{ overQuota: true as const }, { exceeded: true as const, limit: 0 }])('rejects exhausted account quota before opening a session', async quota => {
  const { deps } = fixture(); deps.reserve.mockResolvedValue(quota);
  expect(await executeExternalEvidence(deps, input)).toMatchObject({ status: 'quota_exceeded' });
  expect(deps.reserve).toHaveBeenCalledExactlyOnceWith('owner'); expect(deps.open).not.toHaveBeenCalled();
});

it('free text work does not reserve, refund or create an account ledger', async () => {
  const { deps, execution } = fixture();
  expect(await executeExternalEvidence(deps, { ...input, tool: 'read_video_window' })).toBe('evidence');
  expect(deps.evidenceThrottle).not.toHaveBeenCalled(); expect(deps.reserve).not.toHaveBeenCalled();
  expect(execution.startLedger).not.toHaveBeenCalled(); expect(deps.release).not.toHaveBeenCalled(); expect(execution.finishLedger).not.toHaveBeenCalled();
  expect(execution.close).toHaveBeenCalledOnce();
});

it('reserves the authorized owner before execution, closes before refund and records non-consuming completion', async () => {
  const { deps, execution, invoke } = fixture(), order: string[] = [];
  execution.startLedger.mockImplementation(async value => { expect(value).toBe(reservation); expect(invoke).not.toHaveBeenCalled(); order.push('ledger'); });
  execution.abort.mockImplementation(() => { order.push('abort'); });
  execution.close.mockImplementation(async () => { order.push('close'); });
  deps.release.mockImplementation(async value => { expect(value).toBe(reservation); order.push('refund'); });
  execution.finishLedger.mockImplementation(async () => { order.push('finish'); });
  expect(await executeExternalEvidence(deps, input)).toBe('evidence');
  expect(deps.open).toHaveBeenCalledExactlyOnceWith(course); expect(invoke).toHaveBeenCalledExactlyOnceWith(input.args);
  expect(order).toEqual(['ledger', 'abort', 'close', 'refund', 'finish']);
  expect(execution.finishLedger).toHaveBeenCalledExactlyOnceWith({ status: 'completed', quotaConsumed: false });
});

it('retains the account unit once any provider work completed, even when the tool subsequently fails', async () => {
  const { deps, execution, invoke } = fixture(), error = new Error('tool failed');
  execution.providerCalls.mockReturnValue([{ status: 'failed' }, { status: 'completed' }]); invoke.mockRejectedValue(error);
  await expect(executeExternalEvidence(deps, input)).rejects.toBe(error);
  expect(deps.release).not.toHaveBeenCalled();
  expect(execution.finishLedger).toHaveBeenCalledExactlyOnceWith({ status: 'failed', quotaConsumed: true });
});

it('cleanup cancellation does not turn an execution failure into interruption', async () => {
  const { deps, execution, invoke } = fixture(), error = new Error('tool failed');
  invoke.mockRejectedValue(error);
  execution.abort.mockImplementation(() => { execution.interrupted.mockReturnValue(true); });
  await expect(executeExternalEvidence(deps, input)).rejects.toBe(error);
  expect(execution.finishLedger).toHaveBeenCalledExactlyOnceWith({ status: 'failed', quotaConsumed: false });
  expect(deps.release).toHaveBeenCalledWith(reservation);
});

it.each(['started', 'failed', 'interrupted'] as const)('returns the reserved account unit for provider work that only %s', async status => {
  const { deps, execution } = fixture(); execution.providerCalls.mockReturnValue([{ status }]);
  await executeExternalEvidence(deps, input);
  expect(deps.release).toHaveBeenCalledExactlyOnceWith(reservation);
  expect(execution.finishLedger).toHaveBeenCalledWith({ status: 'completed', quotaConsumed: false });
});

it('records a genuine request interruption separately from cleanup', async () => {
  const { deps, execution } = fixture(); execution.interrupted.mockReturnValue(true);
  await executeExternalEvidence(deps, input);
  expect(execution.finishLedger).toHaveBeenCalledExactlyOnceWith({ status: 'interrupted', quotaConsumed: false });
});

it('refunds an unavailable tool without reporting a completed execution', async () => {
  const { deps, execution, invoke } = fixture(); execution.findTool.mockReturnValue(undefined);
  expect(await executeExternalEvidence(deps, input)).toEqual({ status: 'unavailable', message: 'Tool is unavailable.' });
  expect(invoke).not.toHaveBeenCalled(); expect(deps.release).toHaveBeenCalledWith(reservation);
  expect(execution.finishLedger).toHaveBeenCalledWith({ status: 'failed', quotaConsumed: false });
});

it('does not finish an unstarted ledger after ledger initialization fails', async () => {
  const { deps, execution, invoke } = fixture(), error = new Error('ledger unavailable'); execution.startLedger.mockRejectedValue(error);
  await expect(executeExternalEvidence(deps, input)).rejects.toBe(error);
  expect(invoke).not.toHaveBeenCalled(); expect(deps.release).toHaveBeenCalledWith(reservation); expect(execution.finishLedger).not.toHaveBeenCalled();
});

it('keeps best-effort refund and ledger failures from replacing the tool result', async () => {
  const { deps, execution } = fixture(); deps.release.mockRejectedValue(new Error('refund failed')); execution.finishLedger.mockRejectedValue(new Error('ledger failed'));
  expect(await executeExternalEvidence(deps, input)).toBe('evidence');
  expect(deps.reportFailure.mock.calls).toEqual([['quota_release'], ['usage_finish']]);
});

it('preserves close failure precedence before refund and final ledger operations', async () => {
  const { deps, execution } = fixture(), error = new Error('close failed'); execution.close.mockRejectedValue(error);
  await expect(executeExternalEvidence(deps, input)).rejects.toBe(error);
  expect(deps.release).not.toHaveBeenCalled(); expect(execution.finishLedger).not.toHaveBeenCalled();
});
