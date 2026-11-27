export type LinkedLearningCourse={
  courseId:number;ownerUserId:string;teacherSubject:string;resourceLinkId:string|null;courseTitle:string;
  videos:Array<{videoId:number;lesson:string;title:string}>;
};
