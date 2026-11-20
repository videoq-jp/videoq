import type { z } from 'zod';
import type { courseAuthorityResponse, coursePermissionsSchema } from '../src/features/lms/contracts';
import type { CourseAuthorityResponse, CoursePermissions } from '../src/application/lms-authority';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
export type AuthorityContractMatchesTransport = Assert<Equal<CourseAuthorityResponse, z.infer<typeof courseAuthorityResponse>>>;
export type PermissionsContractMatchesTransport = Assert<Equal<CoursePermissions, z.infer<typeof coursePermissionsSchema>>>;

import type { LtiRegistration, MaterialsService } from '../src/application/lti-registration';
import type { LtiConfig } from '../src/features/lti/config';
import type { materialsServiceSchema } from '../src/features/lms/contracts';
export type RegistrationContractMatchesTransport = Assert<Equal<LtiRegistration, LtiConfig['registrations'][number]>>;
export type ServiceContractMatchesTransport = Assert<Equal<MaterialsService, z.infer<typeof materialsServiceSchema>>>;

import type { ProvisionInstallation } from '../src/application/lti-registration';
import type { provisionInstallationSchema } from '../src/features/lms/installation';
export type ProvisionContractMatchesTransport = Assert<Equal<ProvisionInstallation, z.infer<typeof provisionInstallationSchema>>>;

import type { ResourceManifest } from '../src/application/lms-resource';
import type { resourceManifestSchema } from '../src/features/lms/resource';
export type ResourceContractMatchesTransport = Assert<Equal<ResourceManifest, z.infer<typeof resourceManifestSchema>>>;

import type { MaterialsSnapshot, MaterialsExportStatus } from '../src/features/lms/materials-sync-ports';
import type { materialsManifestSchema, exportStatusSchema } from '../src/features/lms/connector-client';
export type MaterialsSnapshotMatchesTransport = Assert<Equal<MaterialsSnapshot, z.infer<typeof materialsManifestSchema>>>;
export type MaterialsExportMatchesTransport = Assert<Equal<MaterialsExportStatus, z.infer<typeof exportStatusSchema>>>;
