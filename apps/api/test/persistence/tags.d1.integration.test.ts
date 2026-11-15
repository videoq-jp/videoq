import {it,expect} from "vitest";
import {createUserTag,updateUserTag} from "../../src/features/tags/service";
import { createD1TagRepository } from "../../src/persistence/d1/tag-repository";
import type { Bindings } from "../../src/types/bindings";
import { createD1Fixture } from "./d1-fixture";
import { tagRepositoryContract } from "./contracts/tag-repository.contract";

tagRepositoryContract("D1 (workerd)", async () => {
  const { database, dispose } = await createD1Fixture();
  for (const id of ["owner", "other"]) {
    await database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
      VALUES (?,?,?,0,0,0,0)`).bind(id, id, `${id}@example.test`).run();
  }
  return {
    repository: createD1TagRepository(database, { USE_S3_STORAGE: "false" } as Bindings),
    linkVideo: async tagId => {
      const video = await database.prepare(`INSERT INTO videos(user_id,file,title,description,uploaded_at,transcript,status,error_message,source_type,source_url,youtube_video_id)
        VALUES ('owner','related.mp4','Related','',strftime('%Y-%m-%dT%H:%M:%fZ','now'),'','completed','','uploaded','','') RETURNING id`).first<{ id: number }>();
      await database.prepare("INSERT INTO video_tags(tag_id,video_id,added_at) VALUES (?,?,?)").bind(tagId, video!.id, new Date().toISOString()).run();
      return video!.id;
    },
    linkCount: async tagId => await database.prepare("SELECT count(*) AS count FROM video_tags WHERE tag_id=?").bind(tagId).first<number>("count") ?? 0,
    dispose,
  };
});

it('maps D1 duplicate names to API conflicts without hiding other constraints',async()=>{
  const fixture=await createD1Fixture();
  try{
    await fixture.database.prepare(`INSERT INTO users(id,username,email,is_over_quota,used_ai_answers,used_processing_seconds,used_storage_bytes)
      VALUES ('owner','owner','owner@example.test',0,0,0,0)`).run();
    const env={DB:fixture.database,DEPLOYMENT_EDITION:'cloud',USE_S3_STORAGE:'false'} as Bindings;
    const first=await createUserTag(env,'owner','Original','blue');
    const second=await createUserTag(env,'owner','Second','green');
    if(!('tag' in first)||!('tag' in second))throw new Error('Valid tags are required.');
    await expect(createUserTag(env,'owner','Original','red')).rejects.toMatchObject({status:409,code:'CONFLICT'});
    await expect(updateUserTag(env,second.tag.id,'owner',{name:'Original'})).rejects.toMatchObject({status:409,code:'CONFLICT'});
    await fixture.database.prepare('CREATE UNIQUE INDEX synthetic_tag_color ON tags(color)').run();
    await expect(createUserTag(env,'owner','Different','blue')).rejects.not.toMatchObject({status:409});
    expect(await fixture.database.prepare('SELECT name FROM tags ORDER BY id').all()).toMatchObject({results:[{name:'Original'},{name:'Second'}]});
  }finally{await fixture.dispose();}
});
