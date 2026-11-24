import { describe } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { isolatedPostgres } from './isolated-postgres';
import { policyEvaluationContract, policyUpdate } from './contracts/policy-evaluation.contract';

const url = process.env.PERSISTENCE_TEST_DATABASE_URL;
(url ? describe : describe.skip)('PostgreSQL policy interpreters', () => {
  policyEvaluationContract('PostgreSQL', async () => {
    const fixture = await isolatedPostgres(url!);
    try {
      await fixture.pool.query('CREATE TABLE policy_facts(status text,bytes bigint,used bigint,quota_limit bigint,additional bigint,applied integer); INSERT INTO policy_facts VALUES(NULL,NULL,0,NULL,0,0)');
      const dialect = new PgDialect();
      return {
        async evaluate(policy, facts) {
          await fixture.pool.query('UPDATE policy_facts SET status=$1,bytes=$2,used=$3,quota_limit=$4,additional=$5,applied=0',
            [facts.status, facts.bytes, facts.used, facts.limit, facts.additional]);
          const query = dialect.sqlToQuery(policyUpdate(policy));
          return (await fixture.pool.query(query.sql, query.params)).rowCount === 1;
        },
        dispose: fixture.dispose,
      };
    } catch (error) { await fixture.dispose(); throw error; }
  });
});
