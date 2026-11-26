import {it,expect} from 'vitest';
import {resolve} from 'node:path';
import {loadMigrationSnapshot} from '../../scripts/d1-migration-manifest';
import {buildMigrationManifest} from '../../scripts/migrations/d1/manifest';
it('maps new policy authority facts without fabricating PostgreSQL historical timestamps or deliveries',async()=>{
 const manifest=buildMigrationManifest(await loadMigrationSnapshot(resolve('drizzle')),await loadMigrationSnapshot(resolve('drizzle-d1')));
 expect(manifest.mapping_complete).toBe(true);
 const expected={policy_readiness:'initialize_empty_no_historical_acceptance_backfill',policy_cleanup:'initialize_empty_observe_future_logical_deletions',policy_notifications:'initialize_empty_delivery_ledger_for_new_facts'};
 for(const [target,policy] of Object.entries(expected)) {
  expect(manifest.target_only).toContainEqual({target,policy});
  expect(manifest.tables.some(table=>table.source===target)).toBe(false);
  expect(manifest.target_insert_order).toContain(target);
 }
});
