import { createD1Fixture } from "./d1-fixture";
import { uploadSessionContract } from "./contracts/upload-session.contract";
import type { Bindings } from "../../src/types/bindings";

uploadSessionContract("D1 workerd", async () => {
  const f = await createD1Fixture();
  return {
    env: { DEPLOYMENT_EDITION: "cloud", DB: f.database } as Bindings,
    execute: async (sql, args = []) => {
      await f.database.prepare(sql).bind(...args.map(value => typeof value === "boolean" ? Number(value) : value)).run();
    },
    snapshot: async () => ({
      users: (await f.database.prepare("SELECT * FROM users ORDER BY id").all()).results,
      sessions: (await f.database.prepare("SELECT * FROM session ORDER BY id").all()).results,
    }),
    dispose: f.dispose,
  };
});
