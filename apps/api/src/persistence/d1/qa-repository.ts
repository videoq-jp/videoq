import {
  and,
  or,
  eq,
  ne,
  inArray,
  isNull,
  exists,
  notExists,
  not,
  desc,
  sql,
  type SQL,
  type SQLWrapper,
} from "drizzle-orm";
import { createD1Connection } from "../../db/d1/connection";
import {
  insertSelectValues,
  runD1Batch,
  withMaterialized,
  type D1Query,
} from "../../db/d1/query-builders";
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
  ltiCredentials as credentials,
  mutationReceipts as receipts,
} from "../../db/schema/sqlite";
import {
  qaNativePermissions,
  qaQuestionScopeAllowed,
  qaContentAbilities,
  qaMutationEffects,
  qaMutationAllowed,
  qaNativeAccessAllowed,
  qaNativeParticipationAllowed,
  qaLtiAccessAllowed,
  validLtiQaScope,
} from "../../features/qa/policy";
import { qaDrizzleLogic as logic } from "../qa-policy-sql";
import type {
  QaQuestion,
  QaReply,
  QaRepository,
  QaPrincipal,
  QaAccess,
  QaCommand,
} from "../contracts/qa-repository";
import {
  forbidden as permissionDenied,
  notFound,
} from "../../application/errors";
import { ltiSessionProof } from "../../shared/lti-session-proof";
import { toUtcIso } from "../../shared/datetime";
const now = sql<string>`strftime('%Y-%m-%dT%H:%M:%fZ','now')`;
function actor(database: D1Database, principal: QaPrincipal, access: QaAccess) {
  const db = createD1Connection(database),
    lti =
      typeof principal === "object" && principal !== null ? principal : null,
    proof = lti?.sessionProof;
  if (proof) ltiSessionProof(proof, proof.sessionHash);
  // Aliases are distinct from stored columns. Every actor/scope value is bound
  // once even when authorization and display predicates reuse it many times.
  const input = db
    .select({
      course: sql<number>`${access.courseId}`.as("qa_course"),
      user: sql<
        string | null
      >`${typeof principal === "string" ? principal : null}`.as("qa_user"),
      author: sql<string | null>`${lti?.authorId ?? null}`.as("qa_author"),
      owner: sql<string | null>`${lti?.ownerUserId ?? null}`.as("qa_owner"),
      ids: sql<string>`${JSON.stringify(lti?.videoIds ?? [])}`.as("qa_ids"),
      size: sql<number>`${lti?.videoIds.length ?? 0}`.as("qa_size"),
      valid:
        sql<number>`${Number(lti ? validLtiQaScope(lti, access) : false)}`.as(
          "qa_valid",
        ),
      authenticated: sql<number>`${Number(principal !== null)}`.as(
        "qa_authenticated",
      ),
      post: sql<number>`${Number(lti?.permissions.post ?? false)}`.as(
        "qa_post",
      ),
      vote: sql<number>`${Number(lti?.permissions.vote ?? false)}`.as(
        "qa_vote",
      ),
      deleteOwn: sql<number>`${Number(lti?.permissions.deleteOwn ?? false)}`.as(
        "qa_delete_own",
      ),
      moderate: sql<number>`${Number(lti?.permissions.moderate ?? false)}`.as(
        "qa_moderate",
      ),
      share: sql<string | null>`${access.shareSlug ?? null}`.as("qa_share"),
      sessionId: sql<string | null>`${proof?.sessionHash ?? null}`.as(
        "qa_session",
      ),
      registration: sql<string | null>`${proof?.registrationId ?? null}`.as(
        "qa_registration",
      ),
      subject: sql<string | null>`${proof?.subjectHash ?? null}`.as(
        "qa_subject",
      ),
    })
    .from(sql`(VALUES(1)) input`);
  const p = db.$with("qa_actor").as(input),
    wrap = (query: SQLWrapper) => withMaterialized("qa_actor", input, query);
  const owner = sql`${db.select({ id: courses.userId }).from(courses).where(eq(courses.id, p.course))}`,
    isOwner = sql`coalesce(${owner}=${p.user},0)`;
  const session = proof
    ? exists(
        db
          .select({ id: users.id })
          .from(users)
          .innerJoin(credentials, eq(credentials.id, p.sessionId))
          .where(
            and(
              eq(users.id, p.owner),
              eq(credentials.kind, sql`'session'`),
              sql`julianday(${credentials.expiresAt})>julianday('now')`,
              eq(
                sql`json_extract(${credentials.payload},'$.registrationId')`,
                p.registration,
              ),
              eq(
                sql`json_extract(${credentials.payload},'$.subjectHash')`,
                p.subject,
              ),
            ),
          ),
      )
    : sql`1`;
  const visibleVideos = db
    .select({ id: members.videoId })
    .from(members)
    .innerJoin(videos, eq(videos.id, members.videoId))
    .where(
      and(
        eq(members.courseId, p.course),
        eq(videos.userId, owner),
        inArray(
          members.videoId,
          db.select({ value: sql`value` }).from(sql`json_each(${p.ids})`),
        ),
      ),
    );
  let guard: SQL;
  if (lti)
    guard = qaLtiAccessAllowed(
      {
        validScope: sql`${p.valid}`,
        ownerMatches: exists(
          db
            .select({ id: courses.id })
            .from(courses)
            .where(and(eq(courses.id, p.course), eq(courses.userId, p.owner))),
        ),
        emptyScope: sql`${p.size}=0`,
        hasVisibleMember: exists(visibleVideos),
      },
      logic,
    );
  else {
    const native = exists(
      db
        .select({ id: courses.id })
        .from(courses)
        .where(
          and(
            eq(courses.id, p.course),
            qaNativeParticipationAllowed(
              {
                managedByLms: sql`${courses.managedByLms}`,
                nativeAccessDisabled: sql`${courses.nativeAccessDisabled}`,
                hasLmsVideo: exists(
                  db
                    .select({ id: members.id })
                    .from(members)
                    .innerJoin(videos, eq(videos.id, members.videoId))
                    .where(
                      and(
                        eq(members.courseId, courses.id),
                        eq(videos.managedByLms, true),
                      ),
                    ),
                ),
              },
              logic,
            ),
          ),
        ),
    );
    guard = qaNativeAccessAllowed(
      access.shareSlug !== undefined,
      {
        owner: isOwner,
        nativeEnabled: native,
        member: exists(
          db
            .select({ id: memberships.id })
            .from(memberships)
            .where(
              and(
                eq(memberships.courseId, p.course),
                eq(memberships.userId, p.user),
              ),
            ),
        ),
        shareMatches: exists(
          db
            .select({ id: courses.id })
            .from(courses)
            .where(
              and(
                eq(courses.id, p.course),
                eq(sql`lower(${courses.shareSlug})`, sql`lower(${p.share})`),
              ),
            ),
        ),
      },
      logic,
    );
  }
  const permissions = lti
    ? {
        canPost: sql`${p.post}`,
        canVote: sql`${p.vote}`,
        canDeleteOwn: sql`${p.deleteOwn}`,
        canModerate: sql`${p.moderate}`,
      }
    : qaNativePermissions(sql`${p.authenticated}`, isOwner);
  const own = (post: { authorId: SQLWrapper; ltiAuthorId: SQLWrapper }) =>
    sql`coalesce(${post.authorId}=${p.user} OR ${post.ltiAuthorId}=${p.author},0)`;
  const scope = lti
    ? qaQuestionScopeAllowed(
        {
          sourceUnbound: isNull(questions.sourceVideoId),
          sourceGranted: inArray(questions.sourceVideoId, visibleVideos),
          videoUnbound: isNull(questions.videoId),
          videoGranted: inArray(questions.videoId, visibleVideos),
        },
        logic,
      )
    : undefined;
  return {
    db,
    p,
    wrap,
    lti,
    course: p.course,
    user: p.user,
    author: p.author,
    owner,
    session,
    guard,
    ...permissions,
    own,
    visible: and(eq(questions.courseId, p.course), scope)!,
    visibleVideos,
  };
}
type Actor = ReturnType<typeof actor>;
function authorFields(
  post: {
    authorId: SQLWrapper;
    ltiAuthorId: SQLWrapper;
    ltiInstructor: SQLWrapper;
  },
  a: Actor,
) {
  return sql<string>`json_object('name',CASE WHEN ${post.ltiAuthorId}=${"0".repeat(64)} THEN 'Deleted participant' WHEN ${post.ltiAuthorId} IS NOT NULL THEN substr(${post.ltiAuthorId},1,12) ELSE ${users.username} END,'source',CASE WHEN ${post.ltiAuthorId} IS NULL THEN 'videoq' ELSE 'moodle' END,'instructor',CASE WHEN ${post.ltiAuthorId} IS NOT NULL THEN ${post.ltiInstructor} ELSE coalesce(${post.authorId}=${a.owner},0) END)`.as(
    "author",
  );
}
function questionFields(a: Actor) {
  const { db } = a,
    permissions = qaContentAbilities(a, a.own(questions), logic);
  const count = db
      .select({ value: sql<number>`count(*)` })
      .from(replies)
      .where(eq(replies.questionId, questions.id)),
    nativeVotes = db
      .select({ value: sql<number>`count(*)` })
      .from(votes)
      .where(eq(votes.questionId, questions.id)),
    externalVotes = db
      .select({ value: sql<number>`count(*)` })
      .from(ltiVotes)
      .where(eq(ltiVotes.questionId, questions.id));
  const voted = or(
    exists(
      db
        .select({ id: votes.questionId })
        .from(votes)
        .where(
          and(eq(votes.questionId, questions.id), eq(votes.userId, a.user)),
        ),
    ),
    exists(
      db
        .select({ id: ltiVotes.questionId })
        .from(ltiVotes)
        .where(
          and(
            eq(ltiVotes.questionId, questions.id),
            eq(ltiVotes.ltiAuthorId, a.author),
          ),
        ),
    ),
  )!;
  return {
    id: questions.id,
    title: questions.title,
    body: questions.body,
    videoId: sql`${videos.id}`.as("videoId"),
    videoTitle: sql`${videos.title}`.as("videoTitle"),
    author: authorFields(questions, a),
    createdAt: sql`${questions.createdAt}`.as("createdAt"),
    updatedAt: sql`${questions.updatedAt}`.as("updatedAt"),
    featured: questions.featured,
    replyCount: sql`${count}`.as("replyCount"),
    votes: sql`${nativeVotes}+${externalVotes}`.as("votes"),
    voted: voted.as("voted"),
    canEdit: permissions.canEdit.as("canEdit"),
    canDelete: permissions.canDelete.as("canDelete"),
  };
}
function questionQuery(a: Actor) {
  const { db, p } = a;
  return db
    .select(questionFields(a))
    .from(p)
    .innerJoin(questions, sql`true`)
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
                eq(members.courseId, questions.courseId),
                eq(members.videoId, videos.id),
              ),
            ),
        ),
      ),
    );
}
function decode(row: Record<string, unknown>) {
  const author = JSON.parse(String(row.author)) as QaQuestion["author"];
  return {
    ...row,
    author: { ...author, instructor: Boolean(author.instructor) },
    createdAt: toUtcIso(String(row.createdAt)),
    updatedAt: toUtcIso(String(row.updatedAt)),
    canEdit: Boolean(row.canEdit),
    canDelete: Boolean(row.canDelete),
  };
}
const question = (row: Record<string, unknown>) =>
  ({
    ...decode(row),
    featured: Boolean(row.featured),
    voted: Boolean(row.voted),
  }) as QaQuestion;
const reply = (row: Record<string, unknown>) => decode(row) as QaReply;
function check(code: number) {
  if (code === 4030)
    throw permissionDenied("The Moodle session is unavailable.");
  if (code === 4031)
    throw permissionDenied("You cannot perform this Q&A operation.");
  if (code)
    throw notFound(
      code === 4041
        ? "Question not found"
        : code === 4042
          ? "Reply not found"
          : code === 4043
            ? "Video not found in this course"
            : "Course not found",
    );
}
function accessStatement(a: Actor) {
  return a.wrap(
    a.db
      .select({
        code: sql`CASE WHEN NOT ${a.session} THEN 4030 WHEN NOT ${a.guard} THEN 4040 ELSE 0 END`.as(
          "code",
        ),
        canPost: a.canPost.as("canPost"),
        canVote: a.canVote.as("canVote"),
        canModerate: a.canModerate.as("canModerate"),
      })
      .from(a.p),
  );
}
function abilities(row: Record<string, unknown>) {
  check(Number(row.code));
  return {
    canPost: Boolean(row.canPost),
    canVote: Boolean(row.canVote),
    canModerate: Boolean(row.canModerate),
  };
}
export function createD1QaRepository(database: D1Database): QaRepository {
  return {
    async list(principal, input) {
      const a = actor(database, principal, input),
        { db } = a;
      const filter = and(
        a.session,
        a.guard,
        a.visible,
        input.videoId == null
          ? undefined
          : eq(questions.videoId, input.videoId),
        input.search
          ? sql`instr(lower(${questions.title}||' '||${questions.body}),lower(${input.search}))>0`
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
      const result = await runD1Batch<Record<string, unknown>>(database, [
        accessStatement(a),
        a.wrap(
          questionQuery(a)
            .where(filter)
            .orderBy(
              desc(questions.featured),
              ...(input.sort === "votes" ? [sql`votes DESC`] : []),
              desc(questions.createdAt),
              desc(questions.id),
            )
            .limit(input.limit)
            .offset(input.offset),
        ),
        a.wrap(
          db
            .select({ total: sql`count(*)`.as("total") })
            .from(a.p)
            .innerJoin(questions, sql`true`)
            .where(filter),
        ),
      ]);
      return {
        items: result[1].results.map(question),
        total: Number(result[2].results[0].total),
        ...abilities(result[0].results[0]),
      };
    },
    async get(principal, input) {
      const a = actor(database, principal, input),
        { db } = a,
        permissions = qaContentAbilities(a, a.own(replies), logic),
        visible = and(
          a.session,
          a.guard,
          a.visible,
          eq(questions.id, input.questionId),
        );
      const result = await runD1Batch<Record<string, unknown>>(database, [
        accessStatement(a),
        a.wrap(questionQuery(a).where(visible)),
        a.wrap(
          db
            .select({
              id: replies.id,
              body: replies.body,
              author: authorFields(replies, a),
              createdAt: sql`${replies.createdAt}`.as("createdAt"),
              updatedAt: sql`${replies.updatedAt}`.as("updatedAt"),
              canEdit: permissions.canEdit.as("canEdit"),
              canDelete: permissions.canDelete.as("canDelete"),
            })
            .from(a.p)
            .innerJoin(replies, sql`true`)
            .leftJoin(users, eq(users.id, replies.authorId))
            .where(
              inArray(
                replies.questionId,
                db.select({ id: questions.id }).from(questions).where(visible),
              ),
            )
            .orderBy(replies.createdAt, replies.id)
            .limit(input.limit)
            .offset(input.offset),
        ),
      ]);
      const permission = abilities(result[0].results[0]),
        row = result[1].results[0];
      if (!row) throw notFound("Question not found");
      const q = question(row);
      return {
        question: q,
        replies: result[2].results.map(reply),
        replyTotal: q.replyCount,
        ...permission,
      };
    },
    async mutate(principal, command) {
      return mutate(database, principal, command);
    },
  };
}
async function mutate(
  database: D1Database,
  principal: Exclude<QaPrincipal, null>,
  command: QaCommand,
): Promise<{ id: string } | { success: true }> {
  const { name, input } = command,
    token = crypto.randomUUID(),
    id = crypto.randomUUID(),
    a = actor(database, principal, input),
    { db } = a;
  const qid = "questionId" in input ? input.questionId : "",
    replyId = "replyId" in input ? input.replyId : "";
  const visible = and(a.visible, eq(questions.id, qid)),
    ownQ = exists(
      db
        .select({ id: questions.id })
        .from(questions)
        .where(and(visible, a.own(questions))),
    ),
    ownR = exists(
      db
        .select({ id: replies.id })
        .from(replies)
        .where(
          and(
            eq(replies.id, replyId),
            eq(replies.questionId, qid),
            a.own(replies),
          ),
        ),
    );
  const checks: Array<{ condition: SQL; code: number }> = [
    { condition: not(a.session), code: 4030 },
    { condition: not(a.guard), code: 4040 },
  ];
  if (name === "qa.ask") {
    checks.push({
      condition: not(qaMutationAllowed(name, a, ownQ, ownR, logic)),
      code: 4031,
    });
    if (input.videoId !== null)
      checks.push({
        condition: notExists(
          db
            .select({ id: members.id })
            .from(members)
            .where(
              and(
                eq(members.courseId, a.course),
                eq(members.videoId, input.videoId),
                a.lti ? inArray(members.videoId, a.visibleVideos) : undefined,
              ),
            ),
        ),
        code: 4043,
      });
  } else {
    checks.push({
      condition: notExists(
        db.select({ id: questions.id }).from(questions).where(visible),
      ),
      code: 4041,
    });
    if (name === "qa.updateReply" || name === "qa.deleteReply")
      checks.push({
        condition: notExists(
          db
            .select({ id: replies.id })
            .from(replies)
            .where(and(eq(replies.id, replyId), eq(replies.questionId, qid))),
        ),
        code: 4042,
      });
    checks.push({
      condition: not(qaMutationAllowed(name, a, ownQ, ownR, logic)),
      code: 4031,
    });
  }
  const code = sql`CASE ${sql.join(
    checks.map(({ condition, code }) => sql`WHEN ${condition} THEN ${code}`),
    sql` `,
  )} ELSE 0 END`;
  const statements: D1Query[] = [
    a.wrap(
      db
        .insert(receipts)
        .select(
          db
            .select(
              insertSelectValues(receipts, {
                token,
                kind: "qa",
                resourceId: code,
              }),
            )
            .from(a.p),
        ),
    ),
  ];
  const gate = exists(
    db
      .select({ token: receipts.token })
      .from(receipts)
      .where(
        and(
          eq(receipts.token, token),
          eq(receipts.kind, "qa"),
          eq(receipts.resourceId, 0),
        ),
      ),
  );
  const add = (query: SQLWrapper) => statements.push(a.wrap(query));
  const audit = (
    action: string,
    replyId: string | null = null,
    condition: SQL = sql`1`,
  ) =>
    add(
      db.insert(moderation).select(
        db
          .select(
            insertSelectValues(moderation, {
              id: crypto.randomUUID(),
              courseId: sql`${a.course}`,
              questionId: qid,
              replyId,
              actorUserId: sql`${a.user}`,
              ltiActorId: sql`${a.author}`,
              action,
            }),
          )
          .from(a.p)
          .where(and(gate, condition)),
      ),
    );
  const ownQuestion = exists(
    db
      .select({ id: questions.id })
      .from(questions)
      .where(and(eq(questions.id, qid), a.own(questions))),
  );
  const effects = qaMutationEffects(
    name,
    {
      ownQuestion: ownQ,
      ownReply: ownR,
      featureChanged: sql`0`,
      featured: "featured" in input && input.featured,
    },
    logic,
  );
  const instructor = a.lti?.permissions.instructor ?? false;
  if (name === "qa.ask")
    add(
      db.insert(questions).select(
        db
          .select(
            insertSelectValues(questions, {
              id,
              courseId: sql`${a.course}`,
              videoId: input.videoId,
              sourceVideoId: input.videoId,
              authorId: sql`${a.user}`,
              ltiAuthorId: sql`${a.author}`,
              ltiInstructor: instructor,
              title: input.title,
              body: input.body,
            }),
          )
          .from(a.p)
          .where(gate),
      ),
    );
  else if (name === "qa.updateQuestion")
    add(
      db
        .update(questions)
        .set({
          title: input.title,
          body: input.body,
          ltiInstructor: instructor,
          updatedAt: now,
        })
        .where(and(eq(questions.id, input.questionId), gate)),
    );
  else if (name === "qa.deleteQuestion") {
    if (effects.moderation)
      audit(
        effects.moderation.action,
        null,
        qaMutationEffects(
          name,
          {
            ownQuestion,
            ownReply: sql`0`,
            featureChanged: sql`0`,
            featured: false,
          },
          logic,
        ).moderation!.when,
      );
    add(
      db.delete(questions).where(and(eq(questions.id, input.questionId), gate)),
    );
  } else if (name === "qa.reply")
    add(
      db.insert(replies).select(
        db
          .select(
            insertSelectValues(replies, {
              id,
              questionId: input.questionId,
              authorId: sql`${a.user}`,
              ltiAuthorId: sql`${a.author}`,
              ltiInstructor: instructor,
              body: input.body,
            }),
          )
          .from(a.p)
          .where(gate),
      ),
    );
  else if (name === "qa.updateReply")
    add(
      db
        .update(replies)
        .set({ body: input.body, ltiInstructor: instructor, updatedAt: now })
        .where(and(eq(replies.id, input.replyId), gate)),
    );
  else if (name === "qa.deleteReply") {
    const ownReply = exists(
      db
        .select({ id: replies.id })
        .from(replies)
        .where(and(eq(replies.id, input.replyId), a.own(replies))),
    );
    if (effects.moderation)
      audit(
        effects.moderation.action,
        input.replyId,
        qaMutationEffects(
          name,
          {
            ownQuestion: sql`0`,
            ownReply,
            featureChanged: sql`0`,
            featured: false,
          },
          logic,
        ).moderation!.when,
      );
    add(db.delete(replies).where(and(eq(replies.id, input.replyId), gate)));
  } else if (name === "qa.vote") {
    if (a.lti) {
      if (input.voted)
        add(
          db
            .insert(ltiVotes)
            .select(
              db
                .select(
                  insertSelectValues(ltiVotes, {
                    questionId: input.questionId,
                    ltiAuthorId: sql`${a.author}`,
                  }),
                )
                .from(a.p)
                .where(gate),
            )
            .onConflictDoNothing(),
        );
      else
        add(
          db
            .delete(ltiVotes)
            .where(
              and(
                eq(ltiVotes.questionId, input.questionId),
                eq(ltiVotes.ltiAuthorId, a.lti.authorId),
                gate,
              ),
            ),
        );
    } else {
      if (input.voted)
        add(
          db
            .insert(votes)
            .select(
              db
                .select(
                  insertSelectValues(votes, {
                    questionId: input.questionId,
                    userId: sql`${a.user}`,
                  }),
                )
                .from(a.p)
                .where(gate),
            )
            .onConflictDoNothing(),
        );
      else
        add(
          db
            .delete(votes)
            .where(
              and(
                eq(votes.questionId, input.questionId),
                eq(
                  votes.userId,
                  sql`${typeof principal === "string" ? principal : null}`,
                ),
                gate,
              ),
            ),
        );
    }
  } else if (name === "qa.feature") {
    const changed = exists(
      db
        .select({ id: questions.id })
        .from(questions)
        .where(
          and(
            eq(questions.id, input.questionId),
            ne(questions.featured, input.featured),
          ),
        ),
    );
    if (effects.moderation)
      audit(
        effects.moderation.action,
        null,
        qaMutationEffects(
          name,
          {
            ownQuestion: sql`0`,
            ownReply: sql`0`,
            featureChanged: changed,
            featured: input.featured,
          },
          logic,
        ).moderation!.when,
      );
    add(
      db
        .update(questions)
        .set({ featured: input.featured })
        .where(and(eq(questions.id, input.questionId), gate)),
    );
  }
  if ("questionId" in input && effects.touchQuestion)
    add(
      db
        .update(questions)
        .set({ updatedAt: now })
        .where(and(eq(questions.id, input.questionId), gate)),
    );
  statements.push(
    db
      .delete(receipts)
      .where(and(eq(receipts.token, token), eq(receipts.kind, "qa")))
      .returning({ code: sql<number>`${receipts.resourceId}`.as("code") }),
  );
  const result = await runD1Batch<{ code: number }>(database, statements);
  check(result[result.length - 1].results[0].code);
  return name === "qa.ask" || name === "qa.reply" ? { id } : { success: true };
}
