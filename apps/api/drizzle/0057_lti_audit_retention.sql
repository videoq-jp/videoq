CREATE TABLE "lti_operation_reservations" (
	"key" varchar(64) PRIMARY KEY NOT NULL,
	CONSTRAINT "lti_operation_reservation_key_format" CHECK ("lti_operation_reservations"."key" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE INDEX "course_qa_moderation_retention_idx" ON "course_qa_moderation" USING btree ("created_at","id") WHERE "course_qa_moderation"."lti_actor_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "lti_course_tag_ops_retention_idx" ON "lti_course_tag_operations" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "lti_material_ops_retention_idx" ON "lti_material_operations" USING btree ("created_at","id");