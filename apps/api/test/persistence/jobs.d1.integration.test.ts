import { createD1JobRepository } from "../../src/persistence/d1/job-repository";
import { jobRepositoryContract } from "./contracts/job-repository.contract";
import { createD1Fixture } from "./d1-fixture";

jobRepositoryContract("D1 (workerd)", async () => {
  const { database, dispose } = await createD1Fixture();
  return {
    repository: createD1JobRepository(database),
    expireLease: async jobId => {
      await database.prepare("UPDATE job_executions SET lease_until = '2000-01-01T00:00:00.000Z' WHERE job_id = ?").bind(jobId).run();
    },
    dispose,
  };
});
