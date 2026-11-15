import {toUtcIso} from './datetime';
import type {LmsResource,LmsResourceVideo,LmsResourceData} from '../persistence/contracts/lms-resource-repository';
export function normalizeLmsResource(resource:LmsResource):LmsResource {return {...resource,updatedAt:toUtcIso(resource.updatedAt)};}
export function normalizeLmsResourceVideo(video:LmsResourceVideo):LmsResourceVideo {
 return {...video,uploadedAt:toUtcIso(video.uploadedAt),uploadHeartbeatAt:video.uploadHeartbeatAt===null?null:toUtcIso(video.uploadHeartbeatAt),
  uploadUsagePeriodStart:video.uploadUsagePeriodStart===null?null:toUtcIso(video.uploadUsagePeriodStart)};
}
export function normalizeLmsResourceData(data:LmsResourceData):LmsResourceData {
 return {...data,resource:normalizeLmsResource(data.resource),video:data.video?normalizeLmsResourceVideo(data.video):null};
}
