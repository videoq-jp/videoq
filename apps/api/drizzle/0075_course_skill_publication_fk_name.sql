ALTER TABLE "course_skill_publications" DROP CONSTRAINT "course_skill_publications_candidate_id_course_skill_candidates_id_fk";
--> statement-breakpoint
ALTER TABLE "course_skill_publications" ADD CONSTRAINT "course_skill_publications_candidate_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."course_skill_candidates"("id") ON DELETE cascade ON UPDATE no action;