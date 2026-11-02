import { visitorSession } from "../../lib/visitor-session";
import type { Context } from "hono";
import * as courseService from "../../features/courses/service";
import * as courseMembershipService from "../../features/course-memberships/service";
import * as membershipService from "../../features/membership/service";
import { processExternalTasks } from "../../lib/external-tasks";
import { armMaintenance, DISPATCH_SAFETY_NET_MS } from "../../lib/task-scheduler";
import { clientIp, enforceThrottles } from "../../lib/rate-limit";
import type { AppEnv } from "../../types/bindings";
import { requireUserId, rpcError, type HandlersFor } from "./shared";

function throttleError(retryAfterSec: number): never {
  return rpcError(
    "TOO_MANY_REQUESTS",
    `Request was throttled. Expected available in ${retryAfterSec} seconds.`,
  );
}

async function flushInvitationEmails(
  c: Context<AppEnv>,
  count: number,
): Promise<void> {
  if (count <= 0) return;
  // 即時配送より先に起床を予約する。この直後に Worker が落ちても、
  // 予約さえ残っていれば TASK_SCHEDULER が配送を拾い直せる。
  await armMaintenance(c.env, Date.now() + DISPATCH_SAFETY_NET_MS);
  try {
    c.executionCtx.waitUntil(
      processExternalTasks(c.env, { limit: count, arm: false }).catch((error) => {
        console.error(JSON.stringify({
          event: "invitation_email_flush_failed",
          error: error instanceof Error ? error.message : String(error),
        }));
      }),
    );
  } catch {
    // ExecutionContext が無い経路では即時配送に乗せられない。上で予約した
    // 起床に任せる。
  }
}

function invitationDecisionError(result: Record<string, unknown>): never {
  if ("notFound" in result) {
    return rpcError("NOT_FOUND", "Invitation not found", { appCode: "NOT_FOUND" });
  }
  if ("emailUnverified" in result) {
    return rpcError(
      "FORBIDDEN",
      "Verify the invited email address before responding to this invitation.",
      { appCode: "INVITATION_EMAIL_UNVERIFIED" },
    );
  }
  if ("emailMismatch" in result) {
    return rpcError(
      "FORBIDDEN",
      "Sign in with the account matching the invited email address.",
      { appCode: "INVITATION_EMAIL_MISMATCH" },
    );
  }
  if ("expired" in result) {
    return rpcError("CONFLICT", "This invitation has expired.", {
      appCode: "INVITATION_EXPIRED",
    });
  }
  if ("invalidState" in result) {
    return rpcError("CONFLICT", `This invitation is ${String(result.invalidState)}.`, {
      appCode: "INVITATION_INVALID_STATE",
    });
  }
  return rpcError("CONFLICT", "This invitation cannot be used.");
}

export function courseHandlers(
  c: Context<AppEnv>,
  authenticatedUserId: string | null,
): HandlersFor<"courses"> & HandlersFor<"courseMemberships"> & HandlersFor<"memberships"> {
  const userId = () => requireUserId(authenticatedUserId);
  return {
    "courses.list": async ({ limit, cursor }) => {
      const offset = cursor ?? 0;
      const { count, results } = await courseService.listCourses(c.env, userId(), limit, offset);
      return { data: results, meta: { total: count, limit, offset } };
    },
    "courses.get": async ({ id }) => {
      const course = await courseService.getCourse(c.env, id, userId());
      if (!course) return rpcError("NOT_FOUND", "Course not found");
      return course;
    },
    "courses.shared": async ({ slug }) => {
      const denied = await enforceThrottles(c.env, [
        { scope: "chat_share_token_ip", ident: clientIp(c) },
      ]);
      if (denied) return throttleError(denied.retryAfterSec);
      const course = await courseService.getSharedCourse(c.env, slug);
      if (!course) return rpcError("NOT_FOUND", "Share link not found");
      await visitorSession(c);
      return course;
    },
    "courses.create": async ({ name, description }) => {
      const course = await courseService.createUserCourse(c.env, userId(), name, description);
      if (!course || course.access_role === "public") {
        return rpcError("INTERNAL_SERVER_ERROR", "Created course could not be loaded");
      }
      return { ...course, access_role: course.access_role };
    },
    "courses.update": async ({ id, ...patch }) => {
      const result = await courseService.updateUserCourse(c.env, id, userId(), patch);
      if ("notFound" in result) return rpcError("NOT_FOUND", "Course not found");
      return result.course;
    },
    "courses.delete": async ({ id }) => {
      const result = await courseService.removeCourse(c.env, id, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Course not found");
      return { success: true };
    },
    "courses.reorder": async ({ courseIds }) => {
      const result = await courseService.reorderUserCourses(c.env, userId(), courseIds);
      if ("mismatch" in result) {
        return rpcError("BAD_REQUEST", "Specified course IDs do not match user courses");
      }
      return { courseIds };
    },
    "courses.createShare": async ({ id, shareSlug }) => {
      const result = await courseService.saveShareLink(c.env, id, userId(), shareSlug);
      if ("notFound" in result) return rpcError("NOT_FOUND", "Course not found");
      if ("error" in result) return rpcError("BAD_REQUEST", result.error ?? "Bad request");
      if ("conflict" in result) return rpcError("CONFLICT", result.conflict ?? "Conflict");
      return { message: "Share link saved", share_slug: result.share_slug };
    },
    "courses.deleteShare": async ({ id }) => {
      const result = await courseService.clearShareLink(c.env, id, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Course not found");
      if ("notConfigured" in result) return rpcError("NOT_FOUND", "Share link is not configured");
      return { success: true };
    },

    "courseMemberships.invite": async ({ courseId, emails }) => {
      const uid = userId();
      const denied = await enforceThrottles(c.env, [
        { scope: "course_invitation_user", ident: uid, cost: emails.length },
        { scope: "course_invitation_course", ident: String(courseId), cost: emails.length },
      ]);
      if (denied) return throttleError(denied.retryAfterSec);
      const result = await courseMembershipService.inviteCourseMembers(c.env, courseId, uid, emails);
      if ("notFound" in result) return rpcError("NOT_FOUND", "Course not found");
      if ("tooMany" in result) {
        return rpcError("BAD_REQUEST", `At most ${result.limit} recipients can be invited at once.`);
      }
      await flushInvitationEmails(c, result.results.filter((item) => item.status === "queued").length);
      return { results: result.results };
    },
    "courseMemberships.participants": async ({ courseId }) => {
      const result = await courseMembershipService.getCourseParticipants(c.env, courseId, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Course not found");
      return result;
    },
    "courseMemberships.preview": async ({ token }) => {
      const denied = await enforceThrottles(c.env, [
        { scope: "course_invitation_token_ip", ident: clientIp(c) },
      ]);
      if (denied) return throttleError(denied.retryAfterSec);
      const invitation = await courseMembershipService.previewCourseInvitation(c.env, token);
      if (!invitation) return rpcError("NOT_FOUND", "Invitation not found");
      return invitation;
    },
    "courseMemberships.accept": async ({ token }) => {
      const uid = userId();
      const denied = await enforceThrottles(c.env, [
        { scope: "course_invitation_token_ip", ident: clientIp(c) },
        { scope: "course_invitation_decision_user", ident: uid },
      ]);
      if (denied) return throttleError(denied.retryAfterSec);
      const result = await courseMembershipService.acceptInvitation(c.env, token, uid);
      if (!("ok" in result)) return invitationDecisionError(result);
      return { course_id: result.courseId, status: "accepted" };
    },
    "courseMemberships.decline": async ({ token }) => {
      const uid = userId();
      const denied = await enforceThrottles(c.env, [
        { scope: "course_invitation_token_ip", ident: clientIp(c) },
        { scope: "course_invitation_decision_user", ident: uid },
      ]);
      if (denied) return throttleError(denied.retryAfterSec);
      const result = await courseMembershipService.declineInvitation(c.env, token, uid);
      if (!("ok" in result)) return invitationDecisionError(result);
      return { status: "declined" };
    },
    "courseMemberships.resend": async ({ courseId, invitationId }) => {
      const denied = await enforceThrottles(c.env, [
        { scope: "course_invitation_resend", ident: String(invitationId) },
      ]);
      if (denied) return throttleError(denied.retryAfterSec);
      const result = await courseMembershipService.resendInvitation(
        c.env,
        courseId,
        invitationId,
        userId(),
      );
      if ("notFound" in result) return rpcError("NOT_FOUND", "Invitation not found");
      if ("invalidState" in result) return invitationDecisionError(result);
      await flushInvitationEmails(c, 1);
      return { delivery_status: result.delivery_status, ...(result.invitation_url ? { invitation_url: result.invitation_url } : {}) };
    },
    "courseMemberships.revoke": async ({ courseId, invitationId }) => {
      const result = await courseMembershipService.revokeInvitation(c.env, courseId, invitationId, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Invitation not found");
      if ("invalidState" in result) return invitationDecisionError(result);
      return { success: true };
    },
    "courseMemberships.removeMember": async ({ courseId, userId: memberId }) => {
      const result = await courseMembershipService.removeMember(c.env, courseId, memberId, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Member not found");
      return { success: true };
    },
    "courseMemberships.leave": async ({ courseId }) => {
      const result = await courseMembershipService.leaveCourse(c.env, courseId, userId());
      if ("notFound" in result) return rpcError("NOT_FOUND", "Membership not found");
      return { success: true };
    },

    "memberships.addTags": async ({ videoId, tagIds }) => {
      const result = await membershipService.addTagsToVideo(c.env, userId(), videoId, tagIds);
      if ("notFound" in result) return rpcError("NOT_FOUND", result.notFound ?? "Not found");
      return result;
    },
    "memberships.removeTag": async ({ videoId, tagId }) => {
      const result = await membershipService.removeTagFromVideo(c.env, userId(), videoId, tagId);
      if ("notFound" in result) return rpcError("NOT_FOUND", result.notFound ?? "Not found");
      return result;
    },
    "memberships.reorderVideos": async ({ courseId, videoIds }) => {
      const result = await membershipService.reorderGroupVideos(c.env, userId(), courseId, videoIds);
      if ("notFound" in result) return rpcError("NOT_FOUND", result.notFound ?? "Not found");
      if ("badRequest" in result) return rpcError("BAD_REQUEST", result.badRequest ?? "Bad request");
      return result;
    },
    "memberships.addVideos": async ({ courseId, videoIds }) => {
      const result = await membershipService.addVideosToCourseBulk(c.env, userId(), courseId, videoIds);
      if ("notFound" in result) return rpcError("NOT_FOUND", result.notFound ?? "Not found");
      return result;
    },
    "memberships.addVideo": async ({ courseId, videoId }) => {
      const result = await membershipService.addVideoToCourseOne(c.env, userId(), courseId, videoId);
      if ("notFound" in result) return rpcError("NOT_FOUND", result.notFound ?? "Not found");
      return result;
    },
    "memberships.removeVideo": async ({ courseId, videoId }) => {
      const result = await membershipService.removeVideoFromCourseOne(c.env, userId(), courseId, videoId);
      if ("notFound" in result) return rpcError("NOT_FOUND", result.notFound ?? "Not found");
      return { success: true };
    },
  };
}
