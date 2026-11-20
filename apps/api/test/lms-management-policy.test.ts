import { expect, it, vi } from 'vitest';
import { managementContextView } from '../src/application/lms-management';
import { deploymentFeatures, deploymentEdition } from '@videoq/domain/deployment';

it('keeps recovery and billing available to a cloud owner without reactivating a disconnected connection', () => {
  expect(managementContextView({ systemAdmin: false, connectionActive: false }, () => deploymentFeatures('cloud').billing)).toEqual({
    connection: { owned: true, active: false }, permissions: { account: true, billing: true, systemAdmin: false },
  });
  expect(managementContextView({ systemAdmin: false, connectionActive: false }, () => deploymentFeatures('onprem').billing)?.permissions.billing).toBe(false);
});
it('does not turn system administration into someone else\'s account access or evaluate billing for an unrelated user', () => {
  const billing = vi.fn(() => { throw new Error('must not be evaluated'); });
  expect(managementContextView(null, billing)).toBeNull();
  expect(managementContextView({ systemAdmin: true, connectionActive: null }, billing)).toEqual({
    connection: { owned: false, active: null }, permissions: { account: false, billing: false, systemAdmin: true },
  });
  expect(billing).not.toHaveBeenCalled();
});
it('rejects an unknown deployment edition rather than enabling cloud-only features', () => {
  expect(() => deploymentEdition('unknown')).toThrow('DEPLOYMENT_EDITION');
});
