import {describe,it,expect,vi} from 'vitest';
import {prepareRealRecovery,runRealRecoveryPhase,type RecoverySnapshot,type RealRecoveryProvider} from '../../scripts/migrations/d1/real-recovery';
const archive='d'.repeat(64);
function fixture(){
 const snapshot:RecoverySnapshot={tables:['scenes','users'],data_sha256:'a'.repeat(64),data_bytes:123,schema_sha256:'b'.repeat(64),sequences_sha256:'c'.repeat(64),probe:[]};
 const provider:RealRecoveryProvider={assertQuiescent:vi.fn(()=>Promise.resolve()),snapshot:vi.fn(()=>Promise.resolve(structuredClone(snapshot))),bookmark:vi.fn(()=>Promise.resolve('00000001-00000002-'+'e'.repeat(32))),insertProbe:vi.fn(nonce=>{snapshot.probe=[{token:nonce,kind:'migration_recovery_probe',resource_id:0,effect_applied:0}];return Promise.resolve();}),restore:vi.fn(()=>{snapshot.probe=[];return Promise.resolve();})};
 return {provider,snapshot};
}
describe('real-data recovery metadata probe and full original-data fingerprints',()=>{
 it('restores only after the owned probe is observed and verifies original data, schema and sequences',async()=>{
  const {provider}=fixture(),state=await prepareRealRecovery(provider,archive);
  expect(await runRealRecoveryPhase(provider,state,archive,'mutate')).toMatchObject({recovery_probe_verified:true,existing_probe_reused:false});
  expect(await runRealRecoveryPhase(provider,state,archive,'restore')).toMatchObject({recovery_snapshot_verified:true,provider_restore_acknowledged:true,all_original_tables_verified:3,probe_absent:true,execution_complete:false});
  expect(provider.restore).toHaveBeenCalledWith(state.bookmark);
  expect(await runRealRecoveryPhase(provider,state,archive,'verify')).toMatchObject({recovery_snapshot_verified:true,provider_restore_acknowledged:false});
 });
 it('handles a committed probe whose response was lost without inserting duplicates',async()=>{
  const {provider,snapshot}=fixture(),state=await prepareRealRecovery(provider,archive);
  snapshot.probe=[{token:state.nonce,kind:'migration_recovery_probe',resource_id:0,effect_applied:0}];
  expect(await runRealRecoveryPhase(provider,state,archive,'mutate')).toMatchObject({existing_probe_reused:true});expect(provider.insertProbe).not.toHaveBeenCalled();
 });
 it('does not reissue destructive restore when an ambiguous earlier restore already matches baseline',async()=>{
  const {provider}=fixture(),state=await prepareRealRecovery(provider,archive);
  expect(await runRealRecoveryPhase(provider,state,archive,'restore')).toMatchObject({recovery_snapshot_verified:true,provider_restore_acknowledged:false});expect(provider.restore).not.toHaveBeenCalled();
 });
 it.each(['data_sha256','schema_sha256','sequences_sha256'] as const)('refuses restore when %s changed outside the probe',async(field)=>{
  const {provider,snapshot}=fixture(),state=await prepareRealRecovery(provider,archive);await runRealRecoveryPhase(provider,state,archive,'mutate');snapshot[field]='f'.repeat(64);
  await expect(runRealRecoveryPhase(provider,state,archive,'restore')).rejects.toThrow('changed outside');expect(provider.restore).not.toHaveBeenCalled();
 });
 it('rejects a different DB or corpus before connecting',async()=>{
  const {provider}=fixture(),state=await prepareRealRecovery(provider,archive);vi.mocked(provider.assertQuiescent).mockClear();
  await expect(runRealRecoveryPhase(provider,{...state,database_id:'other'},archive,'restore')).rejects.toThrow('state does not match');
  await expect(runRealRecoveryPhase(provider,state,'0'.repeat(64),'restore')).rejects.toThrow('state does not match');expect(provider.assertQuiescent).not.toHaveBeenCalled();
 });
 it('refuses a foreign marker and refuses to claim recovery while the probe remains',async()=>{
  const {provider,snapshot}=fixture(),state=await prepareRealRecovery(provider,archive);await runRealRecoveryPhase(provider,state,archive,'mutate');snapshot.probe[0].token=crypto.randomUUID();
  await expect(runRealRecoveryPhase(provider,state,archive,'restore')).rejects.toThrow('ownership');expect(provider.restore).not.toHaveBeenCalled();
  await expect(runRealRecoveryPhase(provider,state,archive,'verify')).rejects.toThrow('still exists');
 });
 it('requires a stable baseline and drains writers before any probe or restore',async()=>{
  const {provider,snapshot}=fixture();let calls=0;vi.mocked(provider.snapshot).mockImplementation(()=>{if(++calls===2)snapshot.data_sha256='f'.repeat(64);return Promise.resolve(structuredClone(snapshot));});
  await expect(prepareRealRecovery(provider,archive)).rejects.toThrow('stable');expect(provider.bookmark).not.toHaveBeenCalled();
  const f=fixture(),state=await prepareRealRecovery(f.provider,archive);vi.mocked(f.provider.assertQuiescent).mockRejectedValue(new Error('still writing'));
  await expect(runRealRecoveryPhase(f.provider,state,archive,'mutate')).rejects.toThrow('still writing');expect(f.provider.insertProbe).not.toHaveBeenCalled();
 });
 it('detects a provider restore that acknowledged without restoring the probe',async()=>{
  const {provider}=fixture(),state=await prepareRealRecovery(provider,archive);await runRealRecoveryPhase(provider,state,archive,'mutate');vi.mocked(provider.restore).mockResolvedValue();
  await expect(runRealRecoveryPhase(provider,state,archive,'restore')).rejects.toThrow('not removed');
 });
});
