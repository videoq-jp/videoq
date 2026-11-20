import type { LtiRegistration } from '../../application/lti-registration';
import type { LtiRegistrationRepository } from '../../persistence/contracts/lti-registration-repository';

/** Filter current resources before exposing bindings; configured authorities cannot overlap. */
export function mergeLtiRegistrations(configured: LtiRegistration[],
  snapshot: Awaited<ReturnType<LtiRegistrationRepository['snapshot']>>,
  options: { youtube: boolean; origin(issuer: string): string },
): LtiRegistration[] {
  const { installations, resources, linked } = snapshot;
  const registrations=installations.map((row): LtiRegistration => ({
      id: "db:" + row.id, issuer: row.issuer, clientId: row.clientId,
      authorizationUrl: row.authorizationUrl, jwksUrl: row.jwksUrl,
      ...(row.materialsService ? { materialsService: row.materialsService, deploymentId: row.deploymentId } : { courseAccess: 'moodle' as const }),
      frameOrigins: [options.origin(row.issuer)],
      resources: [...linked.filter(link=>link.installationId===row.id && link.resourceLinkId).map(link=>({
        deploymentId:row.deploymentId,contextId:link.contextId,resourceLinkId:link.resourceLinkId!,courseId:link.courseId,kind:'linked' as const,
      })), ...resources.filter(resource => resource.installationId === row.id && resource.courseId !== null
        && (resource.kind !== 'youtube' || options.youtube)
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
    if (configured.some(item => item.id === registration.id ||
      (item.issuer === registration.issuer && item.clientId === registration.clientId))) {
      throw new Error("Duplicate static/database LTI registration");
    }
  }
  return [...configured, ...registrations];
}
