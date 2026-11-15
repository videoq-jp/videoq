import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import type {MembershipRepository} from '../../../src/persistence/contracts/membership-repository';
type Fixture={repository:MembershipRepository;execute:(sql:string,args?:unknown[])=>Promise<void>;members:()=>Promise<Array<{videoId:number;order:number}>>;tagIds:()=>Promise<number[]>;failBulk:()=>Promise<void>;dispose:()=>Promise<void>};
export function membershipContract(name:string,setup:()=>Promise<Fixture>){
  describe(`${name} membership contract`,()=>{
    let f:Fixture;beforeEach(async()=>{f=await setup();});afterEach(async()=>{await f?.dispose();});
    it('deduplicates tags, preserves idempotence and validates the whole request before adding',async()=>{
      expect(await f.repository.attachTags(1,'owner',[1,1,3])).toEqual({added:2});
      expect(await f.repository.attachTags(1,'owner',[1,3])).toEqual({added:0});
      expect(await f.repository.attachTags(2,'owner',[1,2])).toEqual({notFound:'Resource not found'});
      expect(await f.tagIds()).toEqual([1,3]);
      expect(await f.repository.attachTags(1,'owner',[999])).toEqual({notFound:'Resource not found'});
      expect(await f.repository.attachTags(3,'owner',[])).toEqual({notFound:'Video not found'});
      expect(await f.repository.attachTags(1,'owner',[])).toEqual({added:0});
    });
    it('preserves existing foreign tag links while refusing new foreign links or detachment',async()=>{
      await f.execute('INSERT INTO video_tags(video_id,tag_id,added_at) VALUES(1,2,?)',['2026-11-13']);
      expect(await f.repository.attachTags(1,'owner',[1,2])).toEqual({added:1});
      expect(await f.repository.detachTag(1,2,'owner')).toEqual({notFound:'Tag not found'});
      expect(await f.repository.detachTag(1,1,'owner')).toEqual({ok:true});
      expect(await f.repository.detachTag(1,1,'owner')).toEqual({notFound:'Resource not found'});
      expect(await f.repository.detachTag(3,1,'owner')).toEqual({notFound:'Video not found'});
    });
    it('returns stable member IDs and serializes overlapping single additions',async()=>{
      const results=await Promise.all([f.repository.addVideoToCourse(1,1,'owner'),f.repository.addVideoToCourse(1,1,'owner')]);
      expect(results.filter(r=>'alreadyIn' in r)).toHaveLength(1);
      expect(results.every(r=>'id' in r && r.id===('id' in results[0]?results[0].id:undefined))).toBe(true);
      expect(await f.members()).toEqual([{videoId:1,order:0}]);
    });
    it('bulk adds only missing owned videos in input order and validates all videos atomically',async()=>{
      await f.repository.addVideoToCourse(1,1,'owner');
      expect(await f.repository.addVideosBulk(1,[2,1,2,5],'owner')).toEqual({added:2});
      expect(await f.members()).toEqual([{videoId:1,order:0},{videoId:2,order:1},{videoId:5,order:2}]);
      expect(await f.repository.addVideosBulk(1,[6,3],'owner')).toEqual({notFound:'Some videos not found'});
      expect(await f.repository.addVideosBulk(1,[999],'owner')).toEqual({notFound:'Some videos not found'});
      expect(await f.members()).toHaveLength(3);
      expect(await f.repository.addVideosBulk(1,[],'owner')).toEqual({added:0});
    });
    it('serializes concurrent overlapping bulk additions without duplicated order slots',async()=>{
      const results=await Promise.all([f.repository.addVideosBulk(1,[1,2],'owner'),f.repository.addVideosBulk(1,[2,5],'owner')]);
      expect(results.reduce((n,r)=>n+('added' in r?r.added:0),0)).toBe(3);
      const members=await f.members();expect(members).toHaveLength(3);expect(members.map(m=>m.order)).toEqual([0,1,2]);
      expect(members.map(m=>m.videoId).sort()).toEqual([1,2,5]);
    });
    it('denies foreign and LMS additions, but permits removing an owned legacy LMS link',async()=>{
      expect(await f.repository.addVideoToCourse(2,1,'owner')).toEqual({notFound:'Course not found'});
      expect(await f.repository.addVideosBulk(3,[],'owner')).toEqual({notFound:'Course not found'});
      expect(await f.repository.addVideoToCourse(1,3,'owner')).toEqual({notFound:'Video not found'});
      expect(await f.repository.addVideoToCourse(1,4,'owner')).toEqual({notFound:'Video not found'});
      expect(await f.repository.addVideosBulk(1,[1,4],'owner')).toEqual({notFound:'Some videos not found'});
      await f.execute('INSERT INTO video_course_members(course_id,video_id,"order",added_at) VALUES(1,4,0,?)',['2026-11-13']);
      expect(await f.repository.removeVideoFromCourse(1,4,'owner')).toEqual({ok:true});
      expect(await f.repository.removeVideoFromCourse(1,4,'owner')).toEqual({notMember:true});
      expect(await f.repository.removeVideoFromCourse(1,3,'owner')).toEqual({notFound:'Video not found'});
      expect(await f.repository.removeVideoFromCourse(3,1,'owner')).toEqual({notFound:'Course not found'});
    });
    it('rolls back every bulk insertion on a later SQL failure',async()=>{
      await f.failBulk();await expect(f.repository.addVideosBulk(1,[1,2],'owner')).rejects.toThrow();expect(await f.members()).toEqual([]);
    });
    it('requires a complete unique permutation before updating course order',async()=>{
      await f.repository.addVideosBulk(1,[1,2,5],'owner');
      expect(await f.repository.reorderVideos(1,'owner',[5,1,2])).toEqual({ok:true});
      expect(await f.members()).toEqual([{videoId:5,order:0},{videoId:1,order:1},{videoId:2,order:2}]);
      for(const ids of [[1,1,2],[1,2],[1,2,3],[]])expect(await f.repository.reorderVideos(1,'owner',ids)).toEqual({mismatch:true});
      expect((await f.members()).map(m=>m.videoId)).toEqual([5,1,2]);
      expect(await f.repository.reorderVideos(2,'owner',[])).toEqual({notFound:true});
      expect(await f.repository.reorderVideos(3,'owner',[])).toEqual({notFound:true});
      await f.repository.removeVideoFromCourse(1,1,'owner');await f.repository.removeVideoFromCourse(1,2,'owner');await f.repository.removeVideoFromCourse(1,5,'owner');
      expect(await f.repository.reorderVideos(1,'owner',[])).toEqual({ok:true});
    });

  });
}
