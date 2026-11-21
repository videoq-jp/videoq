import {
  and,
  or,
  eq,
  inArray,
  isNull,
  exists,
  notExists,
  desc,
  sql,
  type SQLWrapper,
} from "drizzle-orm";
import { qaDrizzleLogic as logic } from "../qa-policy-sql";
import {
  qaBooleanLogic,
  qaMutationEffects,
  qaNativePermissions,
  qaQuestionScopeAllowed,
  qaContentAbilities,
  qaMutationAllowed,
  qaNativeAccessAllowed,
  qaNativeParticipationAllowed,
  qaLtiAccessAllowed,
  validLtiQaScope,
} from "../../features/qa/policy";
import type {
  QaAuthor,
  QaListInput,
  QaGetInput,
  QaListResult,
  QaGetResult,
  QaRepository,
  QaPrincipal as Principal,
  QaAccess as Access,
  QaCommand,
} from "../contracts/qa-repository";
import { withDb, type Db } from "../../db/pool";
import {
  courseQuestions as questions,
  courseQuestionReplies as replies,
  courseQuestionVotes as votes,
  courseQuestionLtiVotes as ltiVotes,
  courseQaModeration as moderation,
  videoCourses as courses,
  videoCourseMembers as members,
  videoCourseMemberships as memberships,
  videos,
  users,
} from "../../db/schema";
import {
  forbidden as permissionDenied,
  notFound,
} from "../../application/errors";
import { toUtcIso } from "../../shared/datetime";
import type { Bindings } from "../../types/bindings";
import { lockLtiDataSessionWithDb } from "./lti-session-lock";
type Actor = {
  ownerId: string;
  userId: string | null;
  ltiId: string | null;
  videoIds?: number[];
  canPost: boolean;
  canVote: boolean;
  canDeleteOwn: boolean;
  canModerate: boolean;
  instructor: boolean;
};
const dates = <T extends { createdAt: Date; updatedAt: Date }>(row: T) => ({
  ...row,
  createdAt: toUtcIso(row.createdAt),
  updatedAt: toUtcIso(row.updatedAt),
});
const forbidden = () =>
  permissionDenied("You cannot perform this Q&A operation.");
/** Authority, course/membership locks and effects share the same transaction. */
async function withCourse<T>(
  env: Bindings,
  access: Access,
  principal: Principal,
  operation: (db: Db, actor: Actor) => Promise<T>,
): Promise<T> {
  return withDb(env, (database) =>
    database.transaction(async (db) => {
      if (typeof principal === "object" && principal !== null)
        await lockLtiDataSessionWithDb(
          db,
          principal.ownerUserId,
          principal.sessionProof,
        );
      const [course] = await db
        .select({
          owner: courses.userId,
          share: courses.shareSlug,
          managed: courses.managedByLms,
          disabled: courses.nativeAccessDisabled,
        })
        .from(courses)
        .where(eq(courses.id, access.courseId))
        .for("share");
      if (!course) throw notFound("Course not found");
      let actor: Actor;
      if (typeof principal === "object" && principal !== null) {
        const validScope = validLtiQaScope(principal, access);
        if (!validScope || principal.ownerUserId !== course.owner)
          throw notFound("Course not found");
        const visible = await db
          .select({ id: videos.id })
          .from(members)
          .innerJoin(videos, eq(videos.id, members.videoId))
          .where(
            and(
              eq(members.courseId, access.courseId),
              eq(videos.userId, course.owner),
              inArray(members.videoId, principal.videoIds),
            ),
          )
          .for("share", { of: [members, videos] });
        if (
          !qaLtiAccessAllowed(
            {
              validScope,
              ownerMatches: principal.ownerUserId === course.owner,
              emptyScope: principal.videoIds.length === 0,
              hasVisibleMember: visible.length > 0,
            },
            qaBooleanLogic,
          )
        )
          throw notFound("Course not found");
        actor = {
          ownerId: course.owner,
          userId: null,
          ltiId: principal.authorId,
          videoIds: visible.map((row) => row.id),
          canPost: principal.permissions.post,
          canVote: principal.permissions.vote,
          canDeleteOwn: principal.permissions.deleteOwn,
          canModerate: principal.permissions.moderate,
          instructor: principal.permissions.instructor,
        };
      } else {
        const owner = course.owner === principal;
        let nativeEnabled = true;
        if (!owner || access.shareSlug !== undefined) {
          const protectedVideo = await db
            .select({ id: members.id })
            .from(members)
            .innerJoin(videos, eq(videos.id, members.videoId))
            .where(
              and(
                eq(members.courseId, access.courseId),
                eq(videos.managedByLms, true),
              ),
            )
            .limit(1);
          nativeEnabled = qaNativeParticipationAllowed(
            {
              managedByLms: course.managed,
              nativeAccessDisabled: course.disabled,
              hasLmsVideo: protectedVideo.length > 0,
            },
            qaBooleanLogic,
          );
        }
        const member =
          !owner &&
          access.shareSlug === undefined &&
          principal !== null &&
          nativeEnabled
            ? (
                await db
                  .select({ id: memberships.id })
                  .from(memberships)
                  .where(
                    and(
                      eq(memberships.courseId, access.courseId),
                      eq(memberships.userId, principal),
                    ),
                  )
                  .for("share")
              ).length > 0
            : false;
        if (
          !qaNativeAccessAllowed(
            access.shareSlug !== undefined,
            {
              owner,
              nativeEnabled,
              member,
              shareMatches: Boolean(
                course.share &&
                access.shareSlug !== undefined &&
                course.share.toLowerCase() === access.shareSlug.toLowerCase(),
              ),
            },
            qaBooleanLogic,
          )
        )
          throw notFound("Course not found");
        actor = {
          ownerId: course.owner,
          userId: principal,
          ltiId: null,
          ...qaNativePermissions(principal !== null, owner),
          instructor: false,
        };
      }
      return operation(db, actor);
    }),
  );
}
function visibleQuestion(actor: Actor, courseId: number) {
  return and(
    eq(questions.courseId, courseId),
    actor.videoIds
      ? qaQuestionScopeAllowed(
          {
            sourceUnbound: isNull(questions.sourceVideoId),
            sourceGranted: inArray(questions.sourceVideoId, actor.videoIds),
            videoUnbound: isNull(questions.videoId),
            videoGranted: inArray(questions.videoId, actor.videoIds),
          },
          logic,
        )
      : undefined,
  )!;
}
function own(
  post: { authorId: SQLWrapper; ltiAuthorId: SQLWrapper },
  actor: Actor,
) {
  return sql<boolean>`coalesce(${post.authorId}=${actor.userId}::text OR ${post.ltiAuthorId}=${actor.ltiId}::varchar,false)`;
}
function author(
  post: {
    authorId: SQLWrapper;
    ltiAuthorId: SQLWrapper;
    ltiInstructor: SQLWrapper;
  },
  actor: Actor,
) {
  return sql<QaAuthor>`json_build_object('name',CASE WHEN ${post.ltiAuthorId}=repeat('0',64) THEN 'Deleted participant' WHEN ${post.ltiAuthorId} IS NOT NULL THEN left(${post.ltiAuthorId},12) ELSE ${users.username} END,'source',CASE WHEN ${post.ltiAuthorId} IS NOT NULL THEN 'moodle' ELSE 'videoq' END,'instructor',CASE WHEN ${post.ltiAuthorId} IS NOT NULL THEN ${post.ltiInstructor} ELSE coalesce(${post.authorId}=${actor.ownerId}::text,false) END)`;
}
const contentAbilities = (
  post: { authorId: SQLWrapper; ltiAuthorId: SQLWrapper },
  actor: Actor,
) =>
  qaContentAbilities(
    {
      canPost: sql`${actor.canPost}::boolean`,
      canDeleteOwn: sql`${actor.canDeleteOwn}::boolean`,
      canModerate: sql`${actor.canModerate}::boolean`,
    },
    own(post, actor),
    logic,
  );
function questionFields(db: Db, actor: Actor) {
  const permissions = contentAbilities(questions, actor);
  const replyCount = db
    .select({ count: sql<number>`count(*)::int` })
    .from(replies)
    .where(eq(replies.questionId, questions.id));
  const nativeVotes = db
    .select({ count: sql<number>`count(*)` })
    .from(votes)
    .where(eq(votes.questionId, questions.id));
  const externalVotes = db
    .select({ count: sql<number>`count(*)` })
    .from(ltiVotes)
    .where(eq(ltiVotes.questionId, questions.id));
  const voted = or(
    exists(
      db
        .select({ id: votes.questionId })
        .from(votes)
        .where(
          and(
            eq(votes.questionId, questions.id),
            eq(votes.userId, sql`${actor.userId}::text`),
          ),
        ),
    ),
    exists(
      db
        .select({ id: ltiVotes.questionId })
        .from(ltiVotes)
        .where(
          and(
            eq(ltiVotes.questionId, questions.id),
            eq(ltiVotes.ltiAuthorId, sql`${actor.ltiId}::varchar`),
          ),
        ),
    ),
  )!;
  return {
    id: questions.id,
    title: questions.title,
    body: questions.body,
    videoId: sql<number | null>`${videos.id}::float8`,
    videoTitle: videos.title,
    author: author(questions, actor),
    createdAt: questions.createdAt,
    updatedAt: questions.updatedAt,
    featured: questions.featured,
    replyCount: sql<number>`${replyCount}`,
    votes: sql<number>`(${nativeVotes}+${externalVotes})::int`,
    voted: sql<boolean>`${voted}`,
    canEdit: sql<boolean>`${permissions.canEdit}`,
    canDelete: sql<boolean>`${permissions.canDelete}`,
  };
}
function questionQuery(db: Db, actor: Actor) {
  return db
    .select(questionFields(db, actor))
    .from(questions)
    .leftJoin(users, eq(users.id, questions.authorId))
    .leftJoin(
      videos,
      and(
        eq(videos.id, questions.videoId),
        exists(
          db
            .select({ id: members.id })
            .from(members)
            .where(
              and(
                eq(members.videoId, videos.id),
                eq(members.courseId, questions.courseId),
              ),
            ),
        ),
      ),
    );
}
const abilities = (actor: Actor) => ({
  canPost: actor.canPost,
  canVote: actor.canVote,
  canModerate: actor.canModerate,
});
async function selectQuestion(
  db: Db,
  actor: Actor,
  courseId: number,
  id: string,
) {
  const [row] = await questionQuery(db, actor).where(
    and(visibleQuestion(actor, courseId), eq(questions.id, id)),
  );
  if (!row) throw notFound("Question not found");
  return dates(row);
}
export function listQuestions(
  env: Bindings,
  principal: Principal,
  input: QaListInput,
): Promise<QaListResult> {
  return withCourse(env, input, principal, async (db, actor) => {
    const filter = and(
      visibleQuestion(actor, input.courseId),
      input.videoId === undefined
        ? undefined
        : eq(questions.videoId, input.videoId),
      input.search
        ? sql`position(lower(${input.search}) in lower(${questions.title}||' '||${questions.body}))>0`
        : undefined,
      input.unanswered
        ? notExists(
            db
              .select({ id: replies.id })
              .from(replies)
              .where(eq(replies.questionId, questions.id)),
          )
        : undefined,
    );
    const fields = questionFields(db, actor),
      order = [
        desc(questions.featured),
        ...(input.sort === "votes" ? [desc(fields.votes)] : []),
        desc(questions.createdAt),
        desc(questions.id),
      ];
    const rows = await questionQuery(db, actor)
      .where(filter)
      .orderBy(...order)
      .limit(input.limit)
      .offset(input.offset);
    const [total] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(questions)
      .where(filter);
    return {
      items: rows.map(dates),
      total: total?.total ?? 0,
      ...abilities(actor),
    };
  });
}
export function getQuestion(
  env: Bindings,
  principal: Principal,
  input: QaGetInput,
): Promise<QaGetResult> {
  return withCourse(env, input, principal, async (db, actor) => {
    const question = await selectQuestion(
        db,
        actor,
        input.courseId,
        input.questionId,
      ),
      permissions = contentAbilities(replies, actor);
    const rows = await db
      .select({
        id: replies.id,
        body: replies.body,
        author: author(replies, actor),
        createdAt: replies.createdAt,
        updatedAt: replies.updatedAt,
        canEdit: sql<boolean>`${permissions.canEdit}`,
        canDelete: sql<boolean>`${permissions.canDelete}`,
      })
      .from(replies)
      .leftJoin(users, eq(users.id, replies.authorId))
      .where(eq(replies.questionId, input.questionId))
      .orderBy(replies.createdAt, replies.id)
      .limit(input.limit)
      .offset(input.offset);
    return {
      question,
      replies: rows.map(dates),
      replyTotal: question.replyCount,
      ...abilities(actor),
    };
  });
}
type AuthorRecord = { authorId: string | null; ltiAuthorId: string | null };
const isOwn = (actor: Actor, row: AuthorRecord) =>
  (actor.userId !== null && actor.userId === row.authorId) ||
  (actor.ltiId !== null && actor.ltiId === row.ltiAuthorId);
async function audit(
  db: Db,
  actor: Actor,
  courseId: number,
  questionId: string,
  action: string,
  replyId: string | null = null,
) {
  await db
    .insert(moderation)
    .values({
      courseId,
      questionId,
      replyId,
      actorUserId: actor.userId,
      ltiActorId: actor.ltiId,
      action,
    });
}
export function mutate(
  env: Bindings,
  principal: Exclude<Principal, null>,
  command: QaCommand,
): Promise<{ id: string } | { success: true }> {
  return withCourse(env, command.input, principal, async (db, actor) => {
    const { name, input } = command;
    if (name === "qa.ask") {
      if (!qaMutationAllowed(name, actor, false, false, qaBooleanLogic))
        throw forbidden();
      if (
        input.videoId !== null &&
        ((actor.videoIds && !actor.videoIds.includes(input.videoId)) ||
          !(
            await db
              .select({ id: members.id })
              .from(members)
              .where(
                and(
                  eq(members.courseId, input.courseId),
                  eq(members.videoId, input.videoId),
                ),
              )
              .for("share")
          ).length)
      )
        throw notFound("Video not found in this course");
      const [row] = await db
        .insert(questions)
        .values({
          courseId: input.courseId,
          videoId: input.videoId,
          sourceVideoId: input.videoId,
          authorId: actor.userId,
          ltiAuthorId: actor.ltiId,
          ltiInstructor: actor.instructor,
          title: input.title,
          body: input.body,
        })
        .returning({ id: questions.id });
      return { id: row.id };
    }
    const [question] = await db
      .select({
        authorId: questions.authorId,
        ltiAuthorId: questions.ltiAuthorId,
        featured: questions.featured,
      })
      .from(questions)
      .where(
        and(
          visibleQuestion(actor, input.courseId),
          eq(questions.id, input.questionId),
        ),
      )
      .for("update");
    if (!question) throw notFound("Question not found");
    const effects = qaMutationEffects(
      name,
      {
        ownQuestion: isOwn(actor, question),
        ownReply: false,
        featureChanged:
          "featured" in input && question.featured !== input.featured,
        featured: "featured" in input && input.featured,
      },
      qaBooleanLogic,
    );
    if (name === "qa.updateQuestion") {
      if (
        !qaMutationAllowed(
          name,
          actor,
          isOwn(actor, question),
          false,
          qaBooleanLogic,
        )
      )
        throw forbidden();
      await db
        .update(questions)
        .set({
          title: input.title,
          body: input.body,
          ltiInstructor: actor.instructor,
          updatedAt: sql`now()`,
        })
        .where(eq(questions.id, input.questionId));
    } else if (name === "qa.deleteQuestion") {
      const own = isOwn(actor, question);
      if (!qaMutationAllowed(name, actor, own, own, qaBooleanLogic))
        throw forbidden();
      await db.delete(questions).where(eq(questions.id, input.questionId));
      if (effects.moderation?.when)
        await audit(
          db,
          actor,
          input.courseId,
          input.questionId,
          effects.moderation.action,
        );
    } else if (name === "qa.reply") {
      if (!qaMutationAllowed(name, actor, false, false, qaBooleanLogic))
        throw forbidden();
      const [row] = await db
        .insert(replies)
        .values({
          questionId: input.questionId,
          authorId: actor.userId,
          ltiAuthorId: actor.ltiId,
          ltiInstructor: actor.instructor,
          body: input.body,
        })
        .returning({ id: replies.id });
      if (effects.touchQuestion)
        await db
          .update(questions)
          .set({ updatedAt: sql`now()` })
          .where(eq(questions.id, input.questionId));
      return { id: row.id };
    } else if (name === "qa.updateReply" || name === "qa.deleteReply") {
      const [reply] = await db
        .select({
          authorId: replies.authorId,
          ltiAuthorId: replies.ltiAuthorId,
        })
        .from(replies)
        .where(
          and(
            eq(replies.id, input.replyId),
            eq(replies.questionId, input.questionId),
          ),
        )
        .for("update");
      if (!reply) throw notFound("Reply not found");
      const own = isOwn(actor, reply);
      if (name === "qa.updateReply") {
        if (!qaMutationAllowed(name, actor, false, own, qaBooleanLogic))
          throw forbidden();
        await db
          .update(replies)
          .set({
            body: input.body,
            ltiInstructor: actor.instructor,
            updatedAt: sql`now()`,
          })
          .where(eq(replies.id, input.replyId));
      } else {
        if (!qaMutationAllowed(name, actor, own, own, qaBooleanLogic))
          throw forbidden();
        await db.delete(replies).where(eq(replies.id, input.replyId));
        const moderation = qaMutationEffects(
          name,
          {
            ownQuestion: false,
            ownReply: own,
            featureChanged: false,
            featured: false,
          },
          qaBooleanLogic,
        ).moderation;
        if (moderation?.when)
          await audit(
            db,
            actor,
            input.courseId,
            input.questionId,
            moderation.action,
            input.replyId,
          );
      }
      if (effects.touchQuestion)
        await db
          .update(questions)
          .set({ updatedAt: sql`now()` })
          .where(eq(questions.id, input.questionId));
    } else if (name === "qa.vote") {
      if (!qaMutationAllowed(name, actor, false, false, qaBooleanLogic))
        throw forbidden();
      if (actor.ltiId) {
        if (input.voted)
          await db
            .insert(ltiVotes)
            .values({ questionId: input.questionId, ltiAuthorId: actor.ltiId })
            .onConflictDoNothing();
        else
          await db
            .delete(ltiVotes)
            .where(
              and(
                eq(ltiVotes.questionId, input.questionId),
                eq(ltiVotes.ltiAuthorId, actor.ltiId),
              ),
            );
      } else {
        if (input.voted)
          await db
            .insert(votes)
            .values({
              questionId: input.questionId,
              userId: sql`${actor.userId}`,
            })
            .onConflictDoNothing();
        else
          await db
            .delete(votes)
            .where(
              and(
                eq(votes.questionId, input.questionId),
                eq(votes.userId, sql`${actor.userId}`),
              ),
            );
      }
    } else if (name === "qa.feature") {
      if (!qaMutationAllowed(name, actor, false, false, qaBooleanLogic))
        throw forbidden();
      if (effects.moderation?.when) {
        await db
          .update(questions)
          .set({ featured: input.featured })
          .where(eq(questions.id, input.questionId));
        await audit(
          db,
          actor,
          input.courseId,
          input.questionId,
          effects.moderation.action,
        );
      }
    }
    return { success: true };
  });
}
export function createPostgresQaRepository(env: Bindings): QaRepository {
  return {
    list: (principal, input) => listQuestions(env, principal, input),
    get: (principal, input) => getQuestion(env, principal, input),
    mutate: (principal, command) => mutate(env, principal, command),
  };
}
