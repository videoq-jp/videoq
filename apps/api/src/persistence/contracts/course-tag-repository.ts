import type {LtiSessionProof} from '../../shared/lti-session-proof';
import type {z} from 'zod';
import type {courseTagInput} from '../../shared/course-tags';
export type CourseTagScope = {
  installationId: string; contextId: string; courseId: number; ownerUserId: string; actorKey: string;
  readableVideoIds: number[]; manage: boolean;
  management: { videoId: number; resourceLinkId: string; generation: number }[];
  sessionProof?: LtiSessionProof;
};
export type CourseTag={id:string;name:string;color:string;revision:string;video_ids:string[]};
export type CourseTagCatalog={tags:Array<{id:string;name:string;color:string;revision:string;videoIds:number[];editable:boolean}>;videos:Array<{videoId:number;tagIds:string[];editable:boolean;revision:string}>;canManage:boolean;reused:boolean};
export interface CourseTagRepository{execute(scope:CourseTagScope,input:z.infer<typeof courseTagInput>):Promise<CourseTagCatalog>;}
