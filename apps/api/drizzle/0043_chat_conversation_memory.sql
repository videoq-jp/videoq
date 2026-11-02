CREATE TABLE "chat_conversations" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"actor_user_id" text,
	"course_id" bigint,
	"lease_id" uuid,
	"leased_until" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_course_id_video_courses_id_fk" FOREIGN KEY ("course_id") REFERENCES "public"."video_courses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversations_expiry_idx" ON "chat_conversations" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "chat_conversations_course_idx" ON "chat_conversations" USING btree ("course_id");