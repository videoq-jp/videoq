import { expect, it } from 'vitest';
import { invitationDeliveryPollInterval, previewInvitationRecipients, splitInvitationEmails } from '../../application/course-invitations';

it('preserves invalid input and classifies normalized duplicates before membership and pending state', () => {
  const inputs = splitInvitationEmails('Member@example.test, member@example.test;pending@example.test\nnew@example.test\ninvalid');
  expect(previewInvitationRecipients(inputs, new Set(['member@example.test', 'pending@example.test']), new Set(['pending@example.test']))).toEqual([
    { email: 'member@example.test', status: 'already_member' },
    { email: 'member@example.test', status: 'duplicate' },
    { email: 'pending@example.test', status: 'already_member' },
    { email: 'new@example.test', status: 'ready' },
    { email: 'invalid', status: 'invalid' },
  ]);
  expect(previewInvitationRecipients(['pending@example.test'], new Set(), new Set(['pending@example.test']))[0].status).toBe('already_invited');
});
it('stops polling at the exact deadline even while delivery remains queued', () => {
  const input = { enabled: true, now: 29_999, until: 30_000, invitations: [{ status: 'pending', delivery_status: 'queued' }] };
  expect(invitationDeliveryPollInterval(input)).toBe(3000);
  expect(invitationDeliveryPollInterval({ ...input, now: 30_000 })).toBe(false);
  expect(invitationDeliveryPollInterval({ ...input, enabled: false })).toBe(false);
});
it('does not poll for missing data, finished delivery or nonpending invitations', () => {
  for (const invitations of [undefined, [], [{ status: 'accepted', delivery_status: 'queued' }], [{ status: 'pending', delivery_status: 'sent' }]]) {
    expect(invitationDeliveryPollInterval({ enabled: true, now: 0, until: 30_000, invitations })).toBe(false);
  }
});
