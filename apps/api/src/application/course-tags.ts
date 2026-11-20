import type { LtiSessionProof } from './lti-session-proof';
import type { TAG_COLORS } from '@videoq/domain/tag-policy';
type TagColor = typeof TAG_COLORS[number];
export type CourseTagCommand =
  | { action: 'list' }
  | { action: 'create'; operationId: string; name: string; color: TagColor }
  | { action: 'update'; operationId: string; id: string; revision: string; name: string; color: TagColor }
  | { action: 'delete'; operationId: string; id: string; revision: string }
  | { action: 'assign'; operationId: string; videoId: number; revision: string; tagIds: string[] };
export type CourseTagScope = {
  installationId: string; contextId: string; courseId: number; ownerUserId: string; actorKey: string;
  readableVideoIds: number[]; manage: boolean;
  management: { videoId: number; resourceLinkId: string; generation: number }[];
  sessionProof?: LtiSessionProof;
};
export type CourseTag={id:string;name:string;color:string;revision:string;video_ids:string[]};
export type CourseTagCatalog={tags:Array<{id:string;name:string;color:string;revision:string;videoIds:number[];editable:boolean}>;videos:Array<{videoId:number;tagIds:string[];editable:boolean;revision:string}>;canManage:boolean;reused:boolean};
export const MAX_COURSE_TAGS = 200;
