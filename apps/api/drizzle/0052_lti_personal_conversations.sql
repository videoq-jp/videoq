CREATE TABLE "lti_chat_log_subjects" (
	"chat_log_id" bigint PRIMARY KEY NOT NULL,
	"subject_key" varchar(64) NOT NULL,
	"resource_video_ids" jsonb NOT NULL,
	CONSTRAINT "lti_chat_log_subjects_key_format" CHECK ("lti_chat_log_subjects"."subject_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "lti_chat_log_subjects_resources_array" CHECK (jsonb_typeof("lti_chat_log_subjects"."resource_video_ids") = 'array')
);
--> statement-breakpoint
CREATE TABLE "lti_conversation_scopes" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"subject_key" varchar(64) NOT NULL,
	"resource_video_ids" jsonb NOT NULL,
	CONSTRAINT "lti_conversation_scopes_key_format" CHECK ("lti_conversation_scopes"."subject_key" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "lti_conversation_scopes_resources_array" CHECK (jsonb_typeof("lti_conversation_scopes"."resource_video_ids") = 'array')
);
--> statement-breakpoint
ALTER TABLE "lti_chat_log_subjects" ADD CONSTRAINT "lti_chat_log_subjects_chat_log_id_chat_logs_id_fk" FOREIGN KEY ("chat_log_id") REFERENCES "public"."chat_logs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lti_conversation_scopes" ADD CONSTRAINT "lti_conversation_scopes_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_conversations"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lti_chat_log_subjects_subject_idx" ON "lti_chat_log_subjects" USING btree ("subject_key","chat_log_id");--> statement-breakpoint
CREATE INDEX "lti_conversation_scopes_subject_idx" ON "lti_conversation_scopes" USING btree ("subject_key","thread_id");