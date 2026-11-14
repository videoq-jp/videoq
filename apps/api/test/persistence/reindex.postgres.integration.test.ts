import {describe} from "vitest";
import {isolatedPostgres} from "./isolated-postgres";
import {reindexContract} from "./contracts/reindex.contract";
import {createPostgresReindexRepository} from "../../src/persistence/postgres/reindex-repository";
import type {Bindings} from "../../src/types/bindings";
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL reindex',()=>{
  reindexContract('postgres',async()=>{
    const f=await isolatedPostgres(url!);
    await f.pool.query('CREATE TABLE videos(id integer PRIMARY KEY,status text NOT NULL,transcript text)');
    await f.pool.query(`INSERT INTO videos SELECT id,CASE id WHEN 4 THEN 'processing' WHEN 6 THEN 'error' WHEN 8 THEN 'indexing' WHEN 10 THEN 'uploading' ELSE 'completed' END,
      CASE id WHEN 2 THEN '' WHEN 1 THEN ' ' ELSE 'caption' END FROM generate_series(1,35) id`);
    return {repository:createPostgresReindexRepository({DATABASE_POOL:f.pool} as Bindings),remove:async id=>{await f.pool.query('DELETE FROM videos WHERE id=$1',[id]);},dispose:f.dispose};
  });
});
