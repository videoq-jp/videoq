import { TRPCError } from '@trpc/server';
import { appRouter } from '@videoq/trpc/router';
import type { RpcCaller } from '@videoq/trpc';
import { expect,it,vi } from 'vitest';
const input={job:{type:'reindex_video_transcript',job_id:'job',payload:{video_id:1}}};
it.each(['inspectSearchRecovery','restartSearchWorkflow'] as const)('rejects anonymous and non-admin callers before %s reaches recovery',async procedure=>{
  const call=vi.fn() as unknown as RpcCaller;
  const args={...input,inspection:'a'.repeat(64)};
  const anonymous=appRouter.createCaller({userId:null,assertAdmin:vi.fn(),call});
  await expect(anonymous.admin[procedure](args)).rejects.toMatchObject({code:'UNAUTHORIZED'});
  const nonAdmin=appRouter.createCaller({userId:'user',assertAdmin:async()=>{throw new TRPCError({code:'FORBIDDEN'});},call});
  await expect(nonAdmin.admin[procedure](args)).rejects.toMatchObject({code:'FORBIDDEN'});
  expect(call).not.toHaveBeenCalled();
});
it('requires a reviewed digest even for administrators',async()=>{
  const call=vi.fn() as unknown as RpcCaller;
  const admin=appRouter.createCaller({userId:'admin',assertAdmin:async()=>{},call});
  await expect(admin.admin.restartSearchWorkflow({...input,inspection:'unreviewed'})).rejects.toMatchObject({code:'BAD_REQUEST'});
  expect(call).not.toHaveBeenCalled();
});
