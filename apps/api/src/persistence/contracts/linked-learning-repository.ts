export type LinkedLearningCourse={
  courseId:number;ownerUserId:string;teacherSubject:string;resourceLinkId:string|null;courseTitle:string;
  videos:Array<{videoId:number;lesson:string;title:string}>;
};
/** Resolve a current teacher-owned course and its playable members. */
export interface LinkedLearningRepository {
  findCourse(installationId:string,contextId:string):Promise<LinkedLearningCourse|null>;
}
