export const MAX_SCENE_SEARCHES = 3;
export const MAX_COURSE_INFO_CALLS = 5;
export const COURSE_INFO_PAGE_SIZE = 20;
export const COURSE_DESCRIPTION_LIMIT = 2000;
export const VIDEO_DESCRIPTION_LIMIT = 500;

export type SceneHit = {
  content: string;
  videoId: number;
  videoTitle: string;
  startTime: string;
  endTime: string;
  evidenceType?: "transcript" | "visual";
};
