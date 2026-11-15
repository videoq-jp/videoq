import type {RpcInputMap} from '@videoq/trpc';
import type {Bindings} from '../../types/bindings';
import {createQaRepository} from '../../persistence/factory';
import type {QaPrincipal,QaCommand} from '../../persistence/contracts/qa-repository';
export type {QaCommand,LtiQaPrincipal} from '../../persistence/contracts/qa-repository';
export const listQuestions=async(env:Bindings,principal:QaPrincipal,input:RpcInputMap['qa.list'])=>(await createQaRepository(env)).list(principal,input);
export const getQuestion=async(env:Bindings,principal:QaPrincipal,input:RpcInputMap['qa.get'])=>(await createQaRepository(env)).get(principal,input);
export const mutate=async(env:Bindings,principal:Exclude<QaPrincipal,null>,command:QaCommand)=>(await createQaRepository(env)).mutate(principal,command);
