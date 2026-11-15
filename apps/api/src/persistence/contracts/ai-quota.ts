export type AiAnswerReservation = {
  userId:string;
  /** Opaque database timestamp: preserve its precision for the refund fence. */
  usagePeriodStart:string;
  planCode:string;
  quotaSource:string;
};
export type AiAnswerReservationResult =
  | {reservation:AiAnswerReservation}
  | {overQuota:true}
  | {exceeded:true;limit:number};
export interface AiQuotaRepository {
  reserve(userId:string):Promise<AiAnswerReservationResult>;
  release(reservation:AiAnswerReservation):Promise<void>;
}
