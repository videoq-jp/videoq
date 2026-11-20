import { uniqueMembershipIds, tagAttachmentAllowed, membershipCourseAllowed, membershipVideoAllowed, membershipOrderAllowed } from '../../application/membership-policy';
import { membershipSqlLogic } from '../membership-policy-sql';
import type {MembershipRepository} from '../contracts/membership-repository';
const NOW="strftime('%Y-%m-%dT%H:%M:%fZ','now')";
const VIDEO='EXISTS(SELECT 1 FROM videos WHERE id=? AND user_id=?)';
const COURSE=`EXISTS(SELECT 1 FROM video_courses WHERE id=? AND ${membershipCourseAllowed({owned:'user_id=?',native:'managed_by_lms=0'},membershipSqlLogic)})`;
function courseVideos(ids:number[],userId:string,operation:'add'|'remove'='add'){
  return {sql:`(SELECT count(*) FROM videos WHERE id IN(SELECT value FROM json_each(?)) AND ${membershipVideoAllowed(operation,{owned:'user_id=?',native:'managed_by_lms=0'},membershipSqlLogic)})=?`,
    values:[JSON.stringify(ids),userId,ids.length]};
}
export function createD1MembershipRepository(database:D1Database):MembershipRepository {
  return {
    async reorderVideos(courseId,userId,videoIds){
      const ids=JSON.stringify(videoIds);
      const match=membershipOrderAllowed({
        sameSize:'(SELECT count(*) FROM video_course_members WHERE course_id=?)=?',
        unique:'(SELECT count(DISTINCT value) FROM json_each(?))=?',
        allMembers:`NOT EXISTS(SELECT 1 FROM json_each(?) v WHERE NOT EXISTS(
          SELECT 1 FROM video_course_members m WHERE m.course_id=? AND m.video_id=v.value))`,
      },membershipSqlLogic);
      const values=[courseId,videoIds.length,ids,videoIds.length,ids,courseId];
      const order='(SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value=video_course_members.video_id)';
      const result=await database.batch<{owned:number;matched:number}>([
        database.prepare(`SELECT (${COURSE}) AS owned,(${match}) AS matched`).bind(courseId,userId,...values),
        database.prepare(`UPDATE video_course_members SET "order"=${order} WHERE course_id=? AND (${COURSE}) AND (${match}) AND "order"<>${order}`)
          .bind(ids,courseId,courseId,userId,...values,ids),
      ]);
      const row=result[0].results[0];if(!row.owned)return {notFound:true};
      return row.matched?{ok:true}:{mismatch:true};
    },
    async attachTags(videoId,userId,tagIds){
      const uniqueIds=uniqueMembershipIds(tagIds),ids=JSON.stringify(uniqueIds),length=uniqueIds.length;
      const allowed=`(SELECT count(*) FROM tags t WHERE t.id IN(SELECT value FROM json_each(?)) AND
        ${tagAttachmentAllowed({owned:'t.user_id=?',alreadyLinked:'EXISTS(SELECT 1 FROM video_tags vt WHERE vt.video_id=? AND vt.tag_id=t.id)'},membershipSqlLogic)})=?`;
      const values=[ids,userId,videoId,length];
      const result=await database.batch<{owned:number;allowed:number;id:number}>([
        database.prepare(`SELECT (${VIDEO}) AS owned,(${allowed}) AS allowed`).bind(videoId,userId,...values),
        database.prepare(`INSERT INTO video_tags(video_id,tag_id,added_at) SELECT ?,t.id,${NOW} FROM tags t
          WHERE t.id IN(SELECT value FROM json_each(?)) AND (${VIDEO}) AND (${allowed})
          AND NOT EXISTS(SELECT 1 FROM video_tags vt WHERE vt.video_id=? AND vt.tag_id=t.id)
          ON CONFLICT(tag_id,video_id) DO NOTHING RETURNING id`).bind(videoId,ids,videoId,userId,...values,videoId),
      ]);
      if(!result[0].results[0].owned)return {notFound:'Video not found'};
      if(!result[0].results[0].allowed)return {notFound:'Resource not found'};
      return {added:result[1].results.length};
    },
    async detachTag(videoId,tagId,userId){
      const tag='EXISTS(SELECT 1 FROM tags WHERE id=? AND user_id=?)';
      const result=await database.batch<{owned:number;tag:number;id:number}>([
        database.prepare(`SELECT (${VIDEO}) AS owned,(${tag}) AS tag`).bind(videoId,userId,tagId,userId),
        database.prepare(`DELETE FROM video_tags WHERE video_id=? AND tag_id=? AND (${VIDEO}) AND (${tag}) RETURNING id`).bind(videoId,tagId,videoId,userId,tagId,userId),
      ]);
      if(!result[0].results[0].owned)return {notFound:'Video not found'};
      if(!result[0].results[0].tag)return {notFound:'Tag not found'};
      return result[1].results.length?{ok:true}:{notFound:'Resource not found'};
    },
    async addVideoToCourse(courseId,videoId,userId){
      const videos=courseVideos([videoId],userId);
      const result=await database.batch<{owned:number;allowed:number;existing:number|null;id:number}>([
        database.prepare(`SELECT (${COURSE}) AS owned,(${videos.sql}) AS allowed,
          (SELECT id FROM video_course_members WHERE course_id=? AND video_id=?) AS existing`).bind(courseId,userId,...videos.values,courseId,videoId),
        database.prepare(`INSERT INTO video_course_members(course_id,video_id,"order",added_at)
          SELECT ?,?,(SELECT coalesce(max("order"),-1)+1 FROM video_course_members WHERE course_id=?),${NOW}
          WHERE (${COURSE}) AND (${videos.sql}) AND NOT EXISTS(SELECT 1 FROM video_course_members WHERE course_id=? AND video_id=?) RETURNING id`)
          .bind(courseId,videoId,courseId,courseId,userId,...videos.values,courseId,videoId),
      ]);
      const row=result[0].results[0];if(!row.owned)return {notFound:'Course not found'};
      if(!row.allowed)return {notFound:'Video not found'};
      return row.existing!==null?{alreadyIn:true,id:row.existing}:{id:result[1].results[0].id};
    },
    async removeVideoFromCourse(courseId,videoId,userId){
      const videos=courseVideos([videoId],userId,'remove');
      const result=await database.batch<{owned:number;allowed:number;id:number}>([
        database.prepare(`SELECT (${COURSE}) AS owned,(${videos.sql}) AS allowed`).bind(courseId,userId,...videos.values),
        database.prepare(`DELETE FROM video_course_members WHERE course_id=? AND video_id=? AND (${COURSE}) AND (${videos.sql}) RETURNING id`)
          .bind(courseId,videoId,courseId,userId,...videos.values),
      ]);
      const row=result[0].results[0];if(!row.owned)return {notFound:'Course not found'};
      if(!row.allowed)return {notFound:'Video not found'};
      return result[1].results.length?{ok:true}:{notMember:true};
    },
    async addVideosBulk(courseId,videoIds,userId){
      const ids=uniqueMembershipIds(videoIds),videos=courseVideos(ids,userId);
      const result=await database.batch<{owned:number;allowed:number;id:number}>([
        database.prepare(`SELECT (${COURSE}) AS owned,(${videos.sql}) AS allowed`).bind(courseId,userId,...videos.values),
        database.prepare(`INSERT INTO video_course_members(course_id,video_id,"order",added_at)
          SELECT ?,v.value,(SELECT coalesce(max("order"),-1) FROM video_course_members WHERE course_id=?)
            +row_number() OVER(ORDER BY CAST(v.key AS INTEGER)),${NOW}
          FROM json_each(?) v WHERE (${COURSE}) AND (${videos.sql})
          AND NOT EXISTS(SELECT 1 FROM video_course_members WHERE course_id=? AND video_id=v.value) RETURNING id`)
          .bind(courseId,courseId,JSON.stringify(ids),courseId,userId,...videos.values,courseId),
      ]);
      const row=result[0].results[0];if(!row.owned)return {notFound:'Course not found'};
      if(!row.allowed)return {notFound:'Some videos not found'};
      return {added:result[1].results.length};
    },
  };
}
