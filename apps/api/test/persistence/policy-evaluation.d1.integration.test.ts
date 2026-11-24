import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core';
import { createD1Fixture } from './d1-fixture';
import { policyEvaluationContract, policyUpdate } from './contracts/policy-evaluation.contract';

policyEvaluationContract('D1 workerd', async () => {
  const fixture = await createD1Fixture();
  try {
    await fixture.database.prepare('CREATE TABLE policy_facts(status TEXT,bytes INTEGER,used INTEGER,quota_limit INTEGER,additional INTEGER,applied INTEGER)').run();
    await fixture.database.prepare('INSERT INTO policy_facts VALUES(NULL,NULL,0,NULL,0,0)').run();
    const dialect = new SQLiteSyncDialect();
    return {
      async evaluate(policy, facts) {
        await fixture.database.prepare('UPDATE policy_facts SET status=?,bytes=?,used=?,quota_limit=?,additional=?,applied=0')
          .bind(facts.status, facts.bytes, facts.used, facts.limit, facts.additional).run();
        const query = dialect.sqlToQuery(policyUpdate(policy));
        return (await fixture.database.prepare(query.sql).bind(...query.params).run()).meta.changes === 1;
      },
      dispose: fixture.dispose,
    };
  } catch (error) { await fixture.dispose(); throw error; }
});
