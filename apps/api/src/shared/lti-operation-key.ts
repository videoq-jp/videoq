import {digest} from '../features/lti/store';
export type LtiOperationKind='material'|'tag';
export const operationReservationKey=(kind:LtiOperationKind,id:string)=>digest('videoq:lti-operation:v1:'+kind+':'+id.toLowerCase());
