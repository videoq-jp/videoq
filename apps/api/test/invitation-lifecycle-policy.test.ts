import { expect, it } from 'vitest';
import { invitationBooleanChoice, invitationControlEffects, invitationDecisionEffects, invitationDecisionState, invitationRecipientState, planInvitationControl } from '../src/domain/learning/invitation-lifecycle';

const state = (patch: Partial<{ accepting: boolean; accepted: boolean; acceptedByActor: boolean; notPending: boolean; expired: boolean }>) =>
  invitationDecisionState({ accepting: true, accepted: false, acceptedByActor: false, notPending: false, expired: false, ...patch },
    { replay: 'replay', invalidState: 'state', expired: 'expired', recipient: 'recipient' } as const,
    invitationBooleanChoice<'replay'|'state'|'expired'|'recipient'>());
it('prioritizes same-recipient acceptance replay over terminal state and expiry', () => {
  expect(state({accepted:true,acceptedByActor:true,notPending:true,expired:true})).toBe('replay');
  expect(state({accepting:false,accepted:true,acceptedByActor:true,notPending:true,expired:true})).toBe('state');
  expect(state({accepted:true,acceptedByActor:false,notPending:true,expired:true})).toBe('state');
});
it('checks terminal state, then expiry, before consulting the recipient', () => {
  expect(state({notPending:true,expired:true})).toBe('state');
  expect(state({expired:true})).toBe('expired');
  expect(state({})).toBe('recipient');
});
it.each([
  [true,true,true,'unverified'], [true,false,true,'unverified'],
  [false,true,true,'retry'], [false,true,false,'retry'],
  [false,false,true,'mismatch'], [false,false,false,'apply'],
] as const)('preserves recipient precedence %s/%s/%s', (unverified,identityChanged,emailMismatch,outcome) => {
  expect(invitationRecipientState({unverified,identityChanged,emailMismatch},
    {unverified:'unverified',retry:'retry',mismatch:'mismatch',apply:'apply'},invitationBooleanChoice<string>())).toBe(outcome);
});
it('marks only newly expired pending invitations and treats equality as expired', () => {
  const now=new Date('2026-11-20T00:00:00Z');
  expect(planInvitationControl('pending',now,now)).toEqual({kind:'deny',status:'expired',markExpired:true});
  expect(planInvitationControl('accepted',now,now)).toEqual({kind:'deny',status:'accepted',markExpired:false});
  expect(planInvitationControl('expired',now,now)).toEqual({kind:'deny',status:'expired',markExpired:false});
  expect(planInvitationControl('pending',new Date(now.getTime()+1),now)).toEqual({kind:'apply'});
});
it('preserves membership effects and the decline/revoke exceptions to native authority', () => {
  expect(invitationDecisionEffects('accept')).toEqual({status:'accepted',addMembership:true,requiresNative:true});
  expect(invitationDecisionEffects('decline')).toEqual({status:'declined',addMembership:false,requiresNative:false});
  expect(invitationControlEffects('resend')).toEqual({rotateToken:true,requiresNative:true});
  expect(invitationControlEffects('revoke')).toEqual({rotateToken:false,requiresNative:false});
});
