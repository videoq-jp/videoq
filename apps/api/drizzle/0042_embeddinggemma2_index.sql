CREATE TABLE "scene_embeddings_768" (
	"langchain_id" uuid PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	"embedding" vector(768) NOT NULL,
	"user_id" text NOT NULL,
	"video_id" bigint NOT NULL,
	"langchain_metadata" json
);
--> statement-breakpoint
ALTER TABLE "scene_embeddings_768" ADD CONSTRAINT "scene_embeddings_768_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scene_embeddings_768" ADD CONSTRAINT "scene_embeddings_768_video_id_videos_id_fk" FOREIGN KEY ("video_id") REFERENCES "public"."videos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "scene_embeddings_768_user_id_idx" ON "scene_embeddings_768" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "scene_embeddings_768_video_id_idx" ON "scene_embeddings_768" USING btree ("video_id");