CREATE TABLE "course_skill_files" (
	"revision_id" text NOT NULL,
	"path" text NOT NULL,
	"content" text NOT NULL,
	"digest" text NOT NULL,
	"size" integer NOT NULL,
	CONSTRAINT "course_skill_files_revision_id_path_pk" PRIMARY KEY("revision_id","path")
);
--> statement-breakpoint
CREATE TABLE "course_skill_heads" (
	"course_id" bigint NOT NULL,
	"skill_id" text NOT NULL,
	"revision_id" text NOT NULL,
	CONSTRAINT "course_skill_heads_course_id_skill_id_pk" PRIMARY KEY("course_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "course_skill_publications" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_id" text NOT NULL,
	"course_id" bigint NOT NULL,
	"skill_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'staged' NOT NULL,
	"sources" text NOT NULL,
	"manifest" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course_skill_files" ADD CONSTRAINT "course_skill_files_revision_id_course_skill_publications_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."course_skill_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_skill_heads" ADD CONSTRAINT "course_skill_heads_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_skill_heads" ADD CONSTRAINT "course_skill_heads_revision_id_course_skill_publications_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."course_skill_publications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_skill_publications" ADD CONSTRAINT "course_skill_publications_candidate_id_course_skill_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."course_skill_candidates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_skill_publications" ADD CONSTRAINT "course_skill_publications_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_skill_publications_course_idx" ON "course_skill_publications" USING btree ("course_id","skill_id");