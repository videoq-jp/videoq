import {createNativeSessionRepository} from '../../persistence/factory';
import type {NativeSessionInput} from '../../persistence/contracts/native-session-repository';
import type {Bindings} from '../../types/bindings';
export async function ensureNativeSession(env:Bindings,input:NativeSessionInput):Promise<void>{
 await (await createNativeSessionRepository(env)).ensure(input);
}
