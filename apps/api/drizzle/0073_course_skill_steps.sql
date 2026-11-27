CREATE TABLE "course_skill_steps" (
	"key" text PRIMARY KEY NOT NULL,
	"build_id" text NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course_skill_steps" ADD CONSTRAINT "course_skill_steps_build_id_course_skill_builds_id_fk" FOREIGN KEY ("build_id") REFERENCES "public"."course_skill_builds"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_skill_steps_build_idx" ON "course_skill_steps" USING btree ("build_id");