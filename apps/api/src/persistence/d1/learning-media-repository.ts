import type {LearningMediaRepository,LearningPlaybackVideo} from '../contracts/learning-media-repository';
export function createD1LearningMediaRepository(database:D1Database):LearningMediaRepository {
 return {
  async summaries(ownerUserId,videoIds){
   const ids=[...new Set(videoIds)],queries:D1PreparedStatement[]=[];
   for(let offset=0;offset<ids.length;offset+=80){
    const chunk=ids.slice(offset,offset+80);
    queries.push(database.prepare(`SELECT id,title FROM videos WHERE user_id=? AND status='completed' AND id IN(${chunk.map(()=>'?').join(',')})`).bind(ownerUserId,...chunk));
   }
   const rows:Array<{id:number;title:string}>=[];
   for(let offset=0;offset<queries.length;offset+=25){
    const batch=await database.batch<{id:number;title:string}>(queries.slice(offset,offset+25));
    rows.push(...batch.flatMap(result=>result.results));
   }
   return rows.sort((a,b)=>a.id-b.id);
  },
  async playback(ownerUserId,videoId){return database.prepare(`SELECT file,source_type AS sourceType,youtube_video_id AS youtubeId,title,description
   FROM videos WHERE id=? AND user_id=? AND status='completed'`).bind(videoId,ownerUserId).first<LearningPlaybackVideo>();},
 };
}
