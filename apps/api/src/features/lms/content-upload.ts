import type { LmsResourceData } from '../../persistence/contracts/lms-resource-repository';
import type { LmsUploadSnapshot } from '../../application/lms-upload';
import { createLmsUploadSnapshot, validateLmsUploadResource } from './upload-service';
import { asLmsSyncError } from './resource';
export { uploadLmsContent, confirmLmsUpload } from '../../integrations/lms-upload';

export function lmsUploadResource(data: LmsResourceData | null, generation: number, operation: 'content' | 'confirm') {
  try { validateLmsUploadResource(data, generation, operation); return data; }
  catch (error) { throw asLmsSyncError(error) ?? error; }
}

export function lmsUploadSnapshot(data: LmsResourceData | null, externalId: string, generation: number): LmsUploadSnapshot {
  try { return createLmsUploadSnapshot(data, externalId, generation); }
  catch (error) { throw asLmsSyncError(error) ?? error; }
}
