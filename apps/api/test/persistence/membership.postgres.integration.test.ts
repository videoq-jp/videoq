import {describe} from 'vitest';
import {isolatedPostgres} from './isolated-postgres';
import {membershipContract} from './contracts/membership.contract';
import {createMembershipRepository} from '../../src/persistence/factory';
import type {Bindings} from '../../src/types/bindings';
const url=process.env.PERSISTENCE_TEST_DATABASE_URL;
(url?describe:describe.skip)('PostgreSQL membership',()=>{
  membershipContract('PostgreSQL',async()=>{
    const f=await isolatedPostgres(url!);
    const execute=async(sql:string,args:unknown[]=[])=>{let index=0;await f.pool.query(sql.replaceAll('?',()=>`$${++index}`),args);};
    await execute(`CREATE TABLE videos(id bigint PRIMARY KEY,user_id text,managed_by_lms boolean DEFAULT false);
      CREATE TABLE video_courses(id bigint PRIMARY KEY,user_id text,managed_by_lms boolean DEFAULT false);
      CREATE TABLE tags(id bigint PRIMARY KEY,user_id text);
      CREATE TABLE video_tags(id bigserial PRIMARY KEY,video_id bigint REFERENCES videos,tag_id bigint REFERENCES tags,added_at timestamptz,UNIQUE(tag_id,video_id));
      CREATE TABLE video_course_members(id bigserial PRIMARY KEY,course_id bigint REFERENCES video_courses,video_id bigint REFERENCES videos,"order" integer,added_at timestamptz,UNIQUE(course_id,video_id));
      INSERT INTO videos(id,user_id,managed_by_lms) VALUES(1,'owner',false),(2,'owner',false),(3,'other',false),(4,'owner',true),(5,'owner',false),(6,'owner',false);
      INSERT INTO video_courses VALUES(1,'owner',false),(2,'other',false),(3,'owner',true);
      INSERT INTO tags VALUES(1,'owner'),(2,'other'),(3,'owner');`);
    return {repository:await createMembershipRepository({DATABASE_POOL:f.pool} as Bindings),execute,
      members:async()=>(await f.pool.query<{videoId:string;order:number}>('SELECT video_id AS "videoId","order" FROM video_course_members WHERE course_id=1 ORDER BY "order",id')).rows.map(r=>({...r,videoId:Number(r.videoId)})),
      tagIds:async()=>(await f.pool.query<{id:string}>('SELECT tag_id AS id FROM video_tags ORDER BY tag_id')).rows.map(r=>Number(r.id)),
      failBulk:()=>execute("CREATE FUNCTION fail_bulk() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.video_id=2 THEN RAISE EXCEPTION 'injected bulk failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_bulk BEFORE INSERT ON video_course_members FOR EACH ROW EXECUTE FUNCTION fail_bulk()"),dispose:f.dispose};
  });
});
