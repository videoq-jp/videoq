CREATE TABLE "course_skill_knowledge_chunks" (
	"key" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"video_id" bigint NOT NULL,
	"content" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "course_skill_knowledge_chunks" ADD CONSTRAINT "course_skill_knowledge_chunks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "course_skill_knowledge_chunks" ADD CONSTRAINT "course_skill_knowledge_chunks_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "course_skill_knowledge_owner_video_idx" ON "course_skill_knowledge_chunks" USING btree ("owner_id","video_id");