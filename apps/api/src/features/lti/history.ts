import {chatAnswerSchema} from '@videoq/trpc/chat';
import {createCourseHistoryRepository} from '../../persistence/factory';
import type {CourseHistoryScope as Scope} from '../../persistence/contracts/course-history-repository';
import {savedCourseHistory} from '../../shared/course-history';
import type {Bindings} from '../../types/bindings';
import {digest,randomSecret} from './store';
export const courseHistoryId=(scope:Scope)=>digest(JSON.stringify(['lti-course-history-v1',scope.registrationId,scope.subjectHash,scope.courseId]));
export async function appendCourseHistory(env:Bindings,scope:Scope,question:string,logId:number|null,allowed:number[]|undefined){
 if(logId===null)return;
 await (await createCourseHistoryRepository(env)).append(scope,await courseHistoryId(scope),{id:randomSecret().slice(0,32),logId,question},allowed,new Date(Date.now()+86400_000));
}
export async function readCourseHistory(env:Bindings,scope:Scope,ownerUserId:string,videoIds:number[]){
 const stored=await (await createCourseHistoryRepository(env)).read(scope,await courseHistoryId(scope),ownerUserId);
 if(!stored)return [];
 const record=savedCourseHistory.safeParse(stored.payload);
 if(!record.success||!record.data.scopeVideoIds.every(id=>videoIds.includes(id))||!record.data.turns.length)return [];
  return record.data.turns.flatMap(turn => {
    const row = stored.logs.find(row => row.id === turn.logId);
    const answer = chatAnswerSchema.safeParse(row?.answer);
    if (!row || !answer.success || answer.data.sources.some(source => !videoIds.includes(source.video_id))) return [];
    return [{ ...turn, answer: answer.data, feedback: row.feedback === "good" || row.feedback === "bad" ? row.feedback : null }];
  });
}
