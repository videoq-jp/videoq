CREATE TABLE "course_skill_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"course_id" bigint NOT NULL,
	"build_id" text NOT NULL,
	"skill_id" text NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'review_required' NOT NULL,
	"approved_hash" text
);
--> statement-breakpoint
ALTER TABLE "course_skill_candidates" ADD CONSTRAINT "course_skill_candidates_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_skill_candidates" ADD CONSTRAINT "course_skill_candidates_build_id_course_skill_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."course_skill_builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "course_skill_candidate_task_idx" ON "course_skill_candidates" USING btree ("build_id","skill_id");--> statement-breakpoint
CREATE INDEX "course_skill_candidate_course_idx" ON "course_skill_candidates" USING btree ("course_id");