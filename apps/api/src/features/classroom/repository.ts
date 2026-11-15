import {createLearningMediaRepository} from '../../persistence/factory';
import type {Bindings} from '../../types/bindings';
/** Authorization needs metadata only; never load every transcript in a playlist. */
export async function classroomVideoSummaries(env:Bindings,ownerUserId:string,videoIds:number[]){
 if(!videoIds.length)return [];
 return (await createLearningMediaRepository(env)).summaries(ownerUserId,videoIds);
}
export async function classroomPlaybackVideo(env:Bindings,ownerUserId:string,videoId:number){
 return (await createLearningMediaRepository(env)).playback(ownerUserId,videoId);
}
