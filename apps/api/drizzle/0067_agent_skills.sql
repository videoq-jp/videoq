CREATE TABLE "agent_skills" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"lease_token" text,
	"lease_expires_at" bigint,
	"created_at" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_skills_owner_idx" ON "agent_skills" USING btree ("owner_id");