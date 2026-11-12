CREATE TABLE "course_qa_moderation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"course_id" bigint NOT NULL,
	"question_id" uuid NOT NULL,
	"reply_id" uuid,
	"actor_user_id" text,
	"lti_actor_id" varchar(64),
	"action" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_qa_moderation_actor_kind" CHECK ("course_qa_moderation"."actor_user_id" IS NULL OR "course_qa_moderation"."lti_actor_id" IS NULL),
	CONSTRAINT "course_qa_moderation_lti_actor_format" CHECK ("course_qa_moderation"."lti_actor_id" IS NULL OR "course_qa_moderation"."lti_actor_id" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "course_qa_moderation_action" CHECK ("course_qa_moderation"."action" IN ('feature', 'unfeature', 'delete_question', 'delete_reply'))
);
--> statement-breakpoint
CREATE TABLE "course_question_lti_votes" (
	"question_id" uuid NOT NULL,
	"lti_author_id" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "course_question_lti_votes_question_id_lti_author_id_pk" PRIMARY KEY("question_id","lti_author_id"),
	CONSTRAINT "course_question_lti_votes_author_format" CHECK ("course_question_lti_votes"."lti_author_id" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
ALTER TABLE "course_question_replies" ADD COLUMN "lti_author_id" varchar(64);--> statement-breakpoint
ALTER TABLE "course_question_replies" ADD COLUMN "lti_instructor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "course_questions" ADD COLUMN "source_video_id" bigint;--> statement-breakpoint
ALTER TABLE "course_questions" ADD COLUMN "lti_author_id" varchar(64);--> statement-breakpoint
ALTER TABLE "course_questions" ADD COLUMN "lti_instructor" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "course_qa_moderation" ADD CONSTRAINT "course_qa_moderation_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_qa_moderation" ADD CONSTRAINT "course_qa_moderation_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_question_lti_votes" ADD CONSTRAINT "course_question_lti_votes_question_id_course_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."course_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_qa_moderation_course_idx" ON "course_qa_moderation" USING btree ("course_id","created_at");--> statement-breakpoint
CREATE INDEX "course_qa_moderation_lti_actor_idx" ON "course_qa_moderation" USING btree ("lti_actor_id");--> statement-breakpoint
CREATE INDEX "course_question_lti_votes_author_idx" ON "course_question_lti_votes" USING btree ("lti_author_id");--> statement-breakpoint
CREATE INDEX "course_question_replies_lti_author_idx" ON "course_question_replies" USING btree ("lti_author_id");--> statement-breakpoint
CREATE INDEX "course_questions_lti_author_idx" ON "course_questions" USING btree ("lti_author_id","course_id");--> statement-breakpoint
ALTER TABLE "course_question_replies" ADD CONSTRAINT "course_question_replies_author_kind" CHECK ("course_question_replies"."author_id" IS NULL OR "course_question_replies"."lti_author_id" IS NULL);--> statement-breakpoint
ALTER TABLE "course_question_replies" ADD CONSTRAINT "course_question_replies_lti_author_format" CHECK ("course_question_replies"."lti_author_id" IS NULL OR "course_question_replies"."lti_author_id" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "course_questions" ADD CONSTRAINT "course_questions_author_kind" CHECK ("course_questions"."author_id" IS NULL OR "course_questions"."lti_author_id" IS NULL);--> statement-breakpoint
ALTER TABLE "course_questions" ADD CONSTRAINT "course_questions_lti_author_format" CHECK ("course_questions"."lti_author_id" IS NULL OR "course_questions"."lti_author_id" ~ '^[a-f0-9]{64}$');--> statement-breakpoint
ALTER TABLE "course_questions" ADD CONSTRAINT "course_questions_source_positive" CHECK ("course_questions"."source_video_id" IS NULL OR "course_questions"."source_video_id" > 0);