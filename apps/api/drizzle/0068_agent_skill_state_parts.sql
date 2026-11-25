CREATE TABLE "agent_skill_state_parts" (
	"skill_id" text NOT NULL,
	"revision" text NOT NULL,
	"part" integer NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "agent_skill_state_parts_skill_id_revision_part_pk" PRIMARY KEY("skill_id","revision","part")
);
--> statement-breakpoint
ALTER TABLE "agent_skill_state_parts" ADD CONSTRAINT "agent_skill_state_parts_skill_id_agent_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."agent_skills"("id") ON DELETE cascade ON UPDATE no action;