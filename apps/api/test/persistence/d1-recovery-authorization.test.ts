import {PassThrough} from 'node:stream';
import {describe,it,expect} from 'vitest';
import {awaitRecoveryAuthorization} from '../../scripts/migrations/d1/recovery-authorization';
const digest='a'.repeat(64),grant=JSON.stringify({authorize:true,snapshotSha256:digest})+'\n';
describe('private recovery parent authorization',()=>{
 it('accepts a split, exactly matching prepared grant',async()=>{
  const stream=new PassThrough();const result=awaitRecoveryAuthorization(stream,digest);
  stream.write(grant.slice(0,10));stream.write(grant.slice(10));await result;stream.destroy();
 });
 it.each([
  JSON.stringify({authorize:false,snapshotSha256:digest})+'\n',
  JSON.stringify({authorize:true,snapshotSha256:'b'.repeat(64)})+'\n',
  JSON.stringify({authorize:true,snapshotSha256:digest,skipFence:true})+'\n',
  grant+'another line\n','[]\n','null\n','not json\n','x'.repeat(1025),
 ])('rejects malformed or unbound grants without disclosing their contents',async value=>{
  const stream=new PassThrough(),result=awaitRecoveryAuthorization(stream,digest);
  const assertion=expect(result).rejects.toThrow('DURABLE_RECOVERY_AUTHORIZATION_REQUIRED');
  stream.write(value);await assertion;stream.destroy();
 });
 it('rejects EOF before a complete grant',async()=>{
  const stream=new PassThrough(),result=awaitRecoveryAuthorization(stream,digest);
  const assertion=expect(result).rejects.toThrow('DURABLE_RECOVERY_AUTHORIZATION_REQUIRED');
  stream.end(grant.trim());await assertion;
 });
 it('rejects a parent that never responds',async()=>{
  const stream=new PassThrough();await expect(awaitRecoveryAuthorization(stream,digest,5)).rejects.toThrow('DURABLE_RECOVERY_AUTHORIZATION_REQUIRED');stream.destroy();
 });
 it('rejects an already closed pipe',async()=>{
  const stream=new PassThrough();stream.destroy();await expect(awaitRecoveryAuthorization(stream,digest)).rejects.toThrow('DURABLE_RECOVERY_AUTHORIZATION_REQUIRED');
 });
});
