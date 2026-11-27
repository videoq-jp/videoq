import * as material from '../domain/media/material-mutation';
import { conflict, tooLarge } from './errors';
import type { ManagedVideo, ReadableManagedVideo } from '../domain/media/material-model';
export type { MaterialMutationKind, MaterialMutationPlan } from '../domain/media/material-mutation';

// Preserve application failure contracts while the domain owns mutation decisions.
function checked<Args extends unknown[], Result>(decide: (...args: Args) => Result) {
  return (...args: Args): Result => {
    try { return decide(...args); }
    catch (error) {
      if (error instanceof material.MaterialSizeError) throw tooLarge(error.message);
      if (error instanceof material.MaterialMutationError) throw conflict(error.message);
      throw error;
    }
  };
}
export const assertMaterialGeneration = checked(material.assertMaterialGeneration);
export const assertMaterialReferences = checked(material.assertMaterialReferences);
export const assertMaterialReplayIdentity = checked(material.assertMaterialReplayIdentity);
export const assertMaterialOperationAvailable = checked(material.assertMaterialOperationAvailable);
export const assertMaterialRevision = checked(material.assertMaterialRevision);
export const materialMutationKind = checked(material.materialMutationKind);
export const planMaterialMutation = checked(material.planMaterialMutation);
export function assertMaterialReadable(video: ManagedVideo): asserts video is ReadableManagedVideo {
  checked(material.assertMaterialReadable)(video);
}
