export type LearningPlaybackVideo={file:string;sourceType:string;youtubeId:string;title:string;description:string};
/** Minimal metadata for a previously authorized learning transport. */
export interface LearningMediaRepository {
 summaries(ownerUserId:string,videoIds:number[]):Promise<Array<{id:number;title:string}>>;
 playback(ownerUserId:string,videoId:number):Promise<LearningPlaybackVideo|null>;
}
