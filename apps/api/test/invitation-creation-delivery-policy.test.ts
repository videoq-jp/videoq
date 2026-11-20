import { expect, it } from 'vitest';
import { invitationCandidates, invitationCreationAllowed, invitationMemberEmails, invitationPendingExpired, uncreatedInvitationEmails } from '../src/application/invitation-creation';
import { invitationDeliveryCutoff, invitationDeliveryStranded, invitationDeliveryValues, invitationDeliveryWasSent, invitationInviterName } from '../src/application/invitation-delivery';
const logic = { and: (a: boolean, b: boolean) => a && b };
it('normalizes owner/member identities and retains first matching membership order', () => {
  const requested=['owner@example.test','üser@example.test','member@example.test','new@example.test'].map(email=>({email}));
  expect(invitationMemberEmails(requested,' Owner@Example.Test ',['invalid',' Member@Example.Test ','ÜSER@example.test','MEMBER@example.test','other@example.test']))
    .toEqual(['owner@example.test','member@example.test','üser@example.test']);
  expect(invitationCandidates(requested,['owner@example.test','member@example.test','üser@example.test'])).toEqual([{email:'new@example.test'}]);
});
it('preserves pending query order before new conflict fallbacks', () => {
  const inputs=['member','created','conflict','old-b','old-a','conflict'].map(email=>({email}));
  expect(uncreatedInvitationEmails(inputs,['member'],['created'],['old-a','old-b'])).toEqual(['old-a','old-b','conflict']);
  expect(uncreatedInvitationEmails(inputs,['member'],['created'])).toEqual(['conflict','old-b','old-a']);
});
it('requires both new membership and absence of a pending invitation', () => {
  for(const notMember of [false,true])for(const notPending of [false,true]) {
    expect(invitationCreationAllowed({notMember,notPending},logic)).toBe(notMember&&notPending);
    expect(invitationPendingExpired(notMember,notPending,logic)).toBe(notMember&&notPending);
  }
});
it('protects nonpending, nonqueued, recent and still-retrying deliveries', () => {
  const facts={pending:true,queued:true,graceElapsed:true,noLiveTask:true};
  expect(invitationDeliveryStranded(facts,logic)).toBe(true);
  for(const key of Object.keys(facts) as (keyof typeof facts)[])expect(invitationDeliveryStranded({...facts,[key]:false},logic)).toBe(false);
  const now=new Date('2026-11-20T12:00:00Z');expect(invitationDeliveryCutoff(now,60000).toISOString()).toBe('2026-11-20T11:59:00.000Z');
});
it.each([[true,false,'expired','old'],[false,true,'pending','new'],[null,null,'pending','old']] as const)('keeps expired and live separate (%s/%s)', (expired,live,status,token) => {
    expect(invitationDeliveryValues({expired,live},{expiredStatus:'expired',currentStatus:'pending',newToken:'new',currentToken:'old'},
      {when:(condition:boolean|null,yes:string,no:string)=>condition===true?yes:no})).toEqual({status,token});
  });
it('only updates last sent time for sent outcomes and normalizes the inviter display', () => {
  const equals=(a:string,b:'sent')=>a===b;
  expect(invitationDeliveryWasSent('sent',{equals})).toBe(true);
  expect(invitationDeliveryWasSent('failed',{equals})).toBe(false);
  expect(invitationInviterName(' Teacher ','owner')).toBe('Teacher');
  expect(invitationInviterName(' \t','owner')).toBe('owner');
});
