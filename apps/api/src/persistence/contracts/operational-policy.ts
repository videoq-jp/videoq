import type {PolicySnapshot} from '../../application/operational-policy';
export interface OperationalPolicyRepository {
 read(observedAt:string):Promise<PolicySnapshot>;
 claim(id:string,severity:string):Promise<number|null>;
 settle(id:string,attempt:number,delivered:boolean):Promise<boolean>;
}
