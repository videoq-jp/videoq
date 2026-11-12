ALTER TABLE "video_courses" ADD COLUMN "native_access_disabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "videos" ADD COLUMN "managed_by_lms" boolean DEFAULT false NOT NULL;