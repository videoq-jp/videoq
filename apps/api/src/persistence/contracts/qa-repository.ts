import type {RpcInputMap,RpcOutputMap} from '@videoq/trpc';
import type {LtiSessionProof} from '../../shared/lti-session-proof';
/** Internal grant, constructed only after a fresh LMS authorization check. */
export type LtiQaPrincipal = {
  kind: "lti"; courseId: number; ownerUserId: string; authorId: string; videoIds: readonly number[];
  sessionProof?: LtiSessionProof;
  permissions: { view: boolean; post: boolean; vote: boolean; deleteOwn: boolean; moderate: boolean; instructor: boolean };
};
export type QaPrincipal = string | null | LtiQaPrincipal;
export type QaAccess = { courseId: number; shareSlug?: string };
type MutationName = Exclude<Extract<keyof RpcInputMap, `qa.${string}`>, "qa.get" | "qa.list">;
export type QaCommand = { [Name in MutationName]: { name: Name; input: RpcInputMap[Name] } }[MutationName];
export interface QaRepository {
 list(principal:QaPrincipal,input:RpcInputMap['qa.list']):Promise<RpcOutputMap['qa.list']>;
 get(principal:QaPrincipal,input:RpcInputMap['qa.get']):Promise<RpcOutputMap['qa.get']>;
 mutate(principal:Exclude<QaPrincipal,null>,command:QaCommand):Promise<{id:string}|{success:true}>;
}
