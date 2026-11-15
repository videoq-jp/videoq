import { defaultLegacyAuthority } from '../lms/provider-registry';
import {createLtiRegistrationRepository} from '../../persistence/factory';
import type {Bindings} from '../../types/bindings';
import { ltiConfig, type LtiRegistration } from "./config";
import { features } from '../../lib/deployment';

/** Resolve current bindings on each request so Moodle revocation is immediate. */
export async function resolvedLtiConfig(env: Bindings, platform?: {issuer:string;clientId:string}) {
  const config = ltiConfig(env);
  if (!config?.databaseRegistrations) return config;
  const {installations,resources,linked}=await (await createLtiRegistrationRepository(env)).snapshot(platform);
  const registrations=installations.map((row): LtiRegistration => ({
      id: "db:" + row.id, issuer: row.issuer, clientId: row.clientId,
      authorizationUrl: row.authorizationUrl, jwksUrl: row.jwksUrl,
      ...(row.materialsService ? { materialsService: row.materialsService, deploymentId: row.deploymentId } : { courseAccess: defaultLegacyAuthority }),
      frameOrigins: [new URL(row.issuer).origin],
      resources: [...linked.filter(link=>link.installationId===row.id && link.resourceLinkId).map(link=>({
        deploymentId:row.deploymentId,contextId:link.contextId,resourceLinkId:link.resourceLinkId!,courseId:link.courseId,kind:'linked' as const,
      })), ...resources.filter(resource => resource.installationId === row.id && resource.courseId !== null
        && (resource.kind !== 'youtube' || features(env).youtube)
        && (resource.kind !== 'youtube' || resource.sourceType === 'youtube' && resource.actualYoutubeVideoId === resource.youtubeVideoId)
        && (resource.kind === 'course' || resource.status !== null && resource.videoOwner === resource.courseOwner))
        .map(resource => ({ deploymentId: row.deploymentId, contextId: resource.contextId,
          resourceLinkId: resource.resourceLinkId, courseId: resource.courseId!,
          ...(resource.kind === 'course' ? { kind: 'course' as const } : { videoId: resource.videoId! }), generation: resource.generation,
          ...(resource.kind === 'youtube' ? { sourceGeneration: resource.generation } : {}),
          learningAvailable: resource.status === 'completed' }))],
    }));
  // A platform/client must have one authority: never merge operator-controlled
  // legacy bindings with a database-backed school's grants.
  for (const registration of registrations) {
    if (config.registrations.some(item => item.id === registration.id ||
      (item.issuer === registration.issuer && item.clientId === registration.clientId))) {
      throw new Error("Duplicate static/database LTI registration");
    }
  }
  return { ...config, registrations: [...config.registrations, ...registrations] };
}
