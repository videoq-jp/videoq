import type { MaterialsConnection, MaterialsSyncRepository } from '../../persistence/contracts/materials-sync-repository';
import type { LmsResource, LmsResourceData } from '../../persistence/contracts/lms-resource-repository';
import type { LmsGrant } from '../../domain/lms/lms-upload';
import type { ResourceManifest } from '../../domain/lms/lms-resource';

export type MaterialsSnapshot = { contextId: string; complete: true; resources: Array<{ externalId: string; manifest: ResourceManifest }> };
export type MaterialsExportStatus = { jobId: string; generation: number; status: 'queued' | 'uploading' | 'uploaded' | 'failed' | 'stale'; bytes?: number };
export interface MaterialsGateway {
  manifest(contextId: string): Promise<MaterialsSnapshot>;
  courses(): Promise<string[]>;
  acknowledge(contextId: string, externalId: string, generation: number, status: string, error: string | null): Promise<unknown>;
  exportStatus(contextId: string, jobId: string, generation: number): Promise<MaterialsExportStatus>;
  startExport(contextId: string, externalId: string, generation: number, url: string, attempt: string): Promise<MaterialsExportStatus>;
}
export interface MaterialsSyncDependencies {
  readonly enabled: boolean;
  teacher(installationId: string, contextId: string): Promise<{ resourceLinkId: string | null; ownerUserId: string } | null>;
  repository(): Promise<MaterialsSyncRepository>;
  stateKey(prefix: string, ...parts: Array<string | number>): Promise<string>;
  newId(): string;
  client(connection: MaterialsConnection): MaterialsGateway;
  syncResource(grant: LmsGrant, externalId: string, manifest: ResourceManifest): Promise<LmsResource>;
  resource(grant: LmsGrant, externalId: string): Promise<LmsResourceData | null>;
  youtubeDisabled(error: unknown): boolean;
  uploadUrl(key: string, contentType: string, bytes: number): Promise<string>;
  objectSize(key: string): Promise<number | null>;
  processTask(id: number): Promise<unknown>;
  scheduleRecovery(): Promise<unknown>;
}
