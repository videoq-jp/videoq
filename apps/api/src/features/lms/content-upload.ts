import type { LmsResourceData } from '../../persistence/contracts/lms-resource-repository';
import type { LmsUploadSnapshot } from '../../application/lms-upload';
import { createLmsUploadSnapshot } from './upload-service';
import { asLmsSyncError } from './resource';
export { uploadLmsContent, confirmLmsUpload } from '../../integrations/lms-upload';

export function lmsUploadSnapshot(data: LmsResourceData | null, externalId: string, generation: number): LmsUploadSnapshot {
  try { return createLmsUploadSnapshot(data, externalId, generation); }
  catch (error) { throw asLmsSyncError(error) ?? error; }
}
