import { and, eq } from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import { activeD1LmsOwner as activeOwner } from "./lms-owner-policy";
import {
  users,
  teachingConnections,
  videoCourses,
  videoCourseMembers,
  videos,
} from "../../db/schema/sqlite";
import {
  linkedCourseAllowed,
  learningVideoAllowed,
  linkedLessonTitle,
} from "../../domain/media/media-eligibility";
import { mediaDrizzleLogic } from "../media-eligibility-sql";
import type { LinkedLearningRepository } from "../contracts/linked-learning-repository";
export function createD1LinkedLearningRepository(
  database: D1Database,
): LinkedLearningRepository {
  const db = createD1Connection(database);
  return {
    async findCourse(installationId, contextId) {
      const courseAllowed = linkedCourseAllowed(
        {
          ownerMatches: eq(
            videoCourses.userId,
            teachingConnections.ownerUserId,
          ),
          nativeEnabled: eq(videoCourses.nativeAccessDisabled, false),
          connectionActive: eq(teachingConnections.active, true),
        },
        mediaDrizzleLogic,
      );
      const videoAllowed = learningVideoAllowed(
        eq(videos.userId, videoCourses.userId),
        videos.status,
        mediaDrizzleLogic,
      );
      const rows = await db
        .select({
          courseId: videoCourses.id,
          ownerUserId: videoCourses.userId,
          teacherSubject: teachingConnections.teacherSubject,
          resourceLinkId: teachingConnections.resourceLinkId,
          courseTitle: videoCourses.name,
          videoId: videos.id,
          videoTitle: videos.title,
        })
        .from(teachingConnections)
        .innerJoin(
          videoCourses,
          and(eq(videoCourses.id, teachingConnections.courseId), courseAllowed),
        )
        .innerJoin(users, and(eq(users.id, videoCourses.userId), activeOwner()))
        .leftJoin(
          videoCourseMembers,
          eq(videoCourseMembers.courseId, videoCourses.id),
        )
        .leftJoin(
          videos,
          and(eq(videos.id, videoCourseMembers.videoId), videoAllowed),
        )
        .where(
          and(
            eq(teachingConnections.provider, "moodle"),
            eq(teachingConnections.installationId, installationId),
            eq(teachingConnections.contextId, contextId),
          ),
        )
        .orderBy(videoCourseMembers.order, videoCourseMembers.id);
      const row = rows[0];
      if (!row) return null;
      return {
        courseId: Number(row.courseId),
        ownerUserId: row.ownerUserId,
        teacherSubject: row.teacherSubject,
        resourceLinkId: row.resourceLinkId,
        courseTitle: row.courseTitle,
        videos: rows.flatMap((item) =>
          item.videoId === null
            ? []
            : [
                {
                  videoId: Number(item.videoId),
                  lesson: String(item.videoId),
                  title: linkedLessonTitle(item.videoTitle, row.courseTitle),
                },
              ],
        ),
      };
    },
  };
}
