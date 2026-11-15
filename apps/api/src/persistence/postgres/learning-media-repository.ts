import {and,eq,inArray,asc} from 'drizzle-orm';
import {withDb} from '../../db/pool';
import {videos} from '../../db/schema';
import type {Bindings} from '../../types/bindings';
import type {LearningMediaRepository} from '../contracts/learning-media-repository';
export function createPostgresLearningMediaRepository(env:Bindings):LearningMediaRepository {
 return {
  async summaries(ownerUserId,videoIds){
   if(!videoIds.length)return [];
   return withDb(env,db=>db.select({id:videos.id,title:videos.title}).from(videos)
    .where(and(eq(videos.userId,ownerUserId),eq(videos.status,'completed'),inArray(videos.id,videoIds))).orderBy(asc(videos.id)));
  },
  playback(ownerUserId,videoId){return withDb(env,async db=>(await db.select({file:videos.file,sourceType:videos.sourceType,youtubeId:videos.youtubeVideoId,title:videos.title,description:videos.description})
   .from(videos).where(and(eq(videos.id,videoId),eq(videos.userId,ownerUserId),eq(videos.status,'completed'))).limit(1))[0]??null);},
 };
}
