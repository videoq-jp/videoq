import type { MaterialsService, ProvisionInstallation } from '../../domain/lms/lti-registration';
import type { LmsInstallationRepository } from '../../persistence/contracts/lms-installation-repository';

export interface LmsInstallationDependencies {
  newToken(): string;
  hash(token: string): Promise<string | null>;
  repository(): Promise<Pick<LmsInstallationRepository, 'insert' | 'authenticate' | 'rotate'>>;
}

/** Inputs are decoded by the adapter; credentials become visible only after persistence succeeds. */
export function createLmsInstallationService(deps: LmsInstallationDependencies) {
  return {
    async provision(registration: ProvisionInstallation) {
      const token = deps.newToken(), hash = (await deps.hash(token))!;
      await (await deps.repository()).insert({ ...registration, syncTokenHash: hash });
      return { installationId: registration.id, token };
    },
    async provisionService(registration: ProvisionInstallation & { materialsService: MaterialsService }) {
      await (await deps.repository()).insert({ ...registration, syncTokenHash: null });
      return { installationId: registration.id, mode: 'service' as const };
    },
    async authenticate(token: string) {
      const hash = await deps.hash(token);
      return hash ? (await deps.repository()).authenticate(hash) : null;
    },
    async rotate(ownerUserId: string, installationId: string) {
      const token = deps.newToken(), hash = (await deps.hash(token))!;
      const id = await (await deps.repository()).rotate(ownerUserId, installationId, hash);
      return id ? { installationId: id, token } : null;
    },
  };
}
