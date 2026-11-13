import { defaultLegacyAuthority } from '../lms/provider-registry';
import { and, eq, inArray } from "drizzle-orm";
import { withDb } from "../../db/pool";
import { teachingConnections, lmsInstallations, lmsResources, users, videos, videoCourses } from "../../db/schema";
import type { Bindings } from "../../types/bindings";
import { activeLmsOwner } from "../../repositories/lms-installation-repository";
import { ltiConfig, type LtiRegistration } from "./config";
import { features } from '../../lib/deployment';

/** Resolve current bindings on each request so Moodle revocation is immediate. */
export async function resolvedLtiConfig(env: Bindings, platform?: { issuer: string; clientId: string }) {
  const config = ltiConfig(env);
  if (!config?.databaseRegistrations) return config;
  const registrations = await withDb(env, async db => {
    const installations = await db.select({ installation: lmsInstallations })
      .from(lmsInstallations)
      .where(and(eq(lmsInstallations.active, true), ...(platform ? [eq(lmsInstallations.issuer, platform.issuer),
        eq(lmsInstallations.clientId, platform.clientId)] : [])));
    if (!installations.length) return [];
    const installationIds = installations.map(({ installation }) => installation.id);
    const resources = await db.select({ resource: lmsResources, status: videos.status, videoOwner: videos.userId,
      sourceType: videos.sourceType, youtubeVideoId: videos.youtubeVideoId,
      courseOwner: videoCourses.userId }).from(lmsResources)
      .innerJoin(videoCourses, and(eq(videoCourses.id, lmsResources.courseId),
        eq(videoCourses.managedByLms, true), eq(videoCourses.nativeAccessDisabled, true)))
      .innerJoin(teachingConnections, and(eq(teachingConnections.provider, 'moodle'), eq(teachingConnections.installationId, lmsResources.installationId),
        eq(teachingConnections.contextId, lmsResources.contextId), eq(teachingConnections.courseId, videoCourses.id), eq(teachingConnections.active, true),
        eq(teachingConnections.ownerUserId, videoCourses.userId)))
      .innerJoin(users, eq(users.id, videoCourses.userId))
      .leftJoin(videos, eq(videos.id, lmsResources.videoId))
      .where(and(eq(lmsResources.enabled, true), inArray(lmsResources.installationId, installationIds), activeLmsOwner()));
    const linked = await db.select({ link: teachingConnections }).from(teachingConnections)
      .innerJoin(videoCourses, and(eq(videoCourses.id, teachingConnections.courseId), eq(videoCourses.userId, teachingConnections.ownerUserId), eq(videoCourses.nativeAccessDisabled, false)))
      .innerJoin(users, eq(users.id, teachingConnections.ownerUserId))
      .where(and(eq(teachingConnections.provider, 'moodle'), inArray(teachingConnections.installationId, installationIds),
        eq(teachingConnections.active, true), activeLmsOwner()));
    return installations.map(({ installation: row }): LtiRegistration => ({
      id: "db:" + row.id, issuer: row.issuer, clientId: row.clientId,
      authorizationUrl: row.authorizationUrl, jwksUrl: row.jwksUrl,
      ...(row.materialsService ? { materialsService: row.materialsService, deploymentId: row.deploymentId } : { courseAccess: defaultLegacyAuthority }),
      frameOrigins: [new URL(row.issuer).origin],
      resources: [...linked.filter(({ link }) => link.installationId === row.id && link.resourceLinkId).map(({ link }) => ({
        deploymentId: row.deploymentId, contextId: link.contextId, resourceLinkId: link.resourceLinkId!, courseId: link.courseId, kind: 'linked' as const,
      })), ...resources.filter(({ resource, status, courseOwner, videoOwner, sourceType, youtubeVideoId }) => resource.installationId === row.id && resource.courseId !== null
        && (resource.kind !== 'youtube' || features(env).youtube)
        && (resource.kind !== 'youtube' || sourceType === 'youtube' && youtubeVideoId === resource.youtubeVideoId)
        && (resource.kind === 'course' || status !== null && videoOwner === courseOwner))
        .map(({ resource, status }) => ({ deploymentId: row.deploymentId, contextId: resource.contextId,
          resourceLinkId: resource.resourceLinkId, courseId: resource.courseId!,
          ...(resource.kind === 'course' ? { kind: 'course' as const } : { videoId: resource.videoId! }), generation: resource.generation,
          ...(resource.kind === 'youtube' ? { sourceGeneration: resource.generation } : {}),
          learningAvailable: status === 'completed' }))],
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
