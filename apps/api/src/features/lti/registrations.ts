import { and, eq } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { lmsInstallations, lmsResources, users, videos, videoCourses } from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import { activeLmsOwner } from "../../repositories/lms-installation-repository";
import { ltiConfig, type LtiRegistration } from "./config";

/** Resolve current bindings on each request so Moodle revocation is immediate. */
export async function resolvedLtiConfig(env: Bindings) {
  const config = ltiConfig(env);
  if (!config?.databaseRegistrations) return config;
  const registrations = await withDb(env, async db => {
    const installations = await db.select({ installation: lmsInstallations })
      .from(lmsInstallations).innerJoin(users, eq(users.id, lmsInstallations.ownerUserId))
      .where(and(eq(lmsInstallations.active, true), activeLmsOwner()));
    const resources = await db.select({ resource: lmsResources, status: videos.status, videoOwner: videos.userId,
      courseOwner: videoCourses.userId }).from(lmsResources)
      .innerJoin(videoCourses, and(eq(videoCourses.id, lmsResources.courseId),
        eq(videoCourses.managedByLms, true), eq(videoCourses.nativeAccessDisabled, true)))
      .leftJoin(videos, eq(videos.id, lmsResources.videoId))
      .where(eq(lmsResources.enabled, true));
    return installations.map(({ installation: row }): LtiRegistration => ({
      id: "db:" + row.id, issuer: row.issuer, clientId: row.clientId,
      authorizationUrl: row.authorizationUrl, jwksUrl: row.jwksUrl,
      ...(row.materialsService ? { materialsService: row.materialsService, deploymentId: row.deploymentId } : { courseAccess: "moodle" as const }),
      frameOrigins: [new URL(row.issuer).origin],
      resources: resources.filter(({ resource, status, courseOwner, videoOwner }) => resource.installationId === row.id && resource.courseId !== null
        && courseOwner === row.ownerUserId && (resource.kind === 'course' || status !== null && videoOwner === row.ownerUserId))
        .map(({ resource, status }) => ({ deploymentId: row.deploymentId, contextId: resource.contextId,
          resourceLinkId: resource.resourceLinkId, courseId: resource.courseId!,
          ...(resource.kind === 'course' ? { kind: 'course' as const } : { videoId: resource.videoId! }), generation: resource.generation,
          learningAvailable: status === 'completed' })),
    }));
  });
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
