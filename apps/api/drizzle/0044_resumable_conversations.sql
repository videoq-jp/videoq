CREATE TABLE "chat_conversation_turns" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "chat_conversation_turns_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"thread_id" text NOT NULL,
	"checkpoint_id" text NOT NULL,
	"question" text NOT NULL,
	"response" jsonb NOT NULL,
	"chat_log_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "conversation_id" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "scope_key" text;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "created_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD COLUMN "committed_checkpoint_id" text;--> statement-breakpoint
ALTER TABLE "chat_conversation_turns" ADD CONSTRAINT "chat_conversation_turns_chat_log_id_chat_logs_id_fk" FOREIGN KEY ("chat_log_id") REFERENCES "public"."chat_logs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversation_turns" ADD CONSTRAINT "chat_conversation_turns_thread_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."chat_conversations"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversation_turns_checkpoint_idx" ON "chat_conversation_turns" USING btree ("thread_id","checkpoint_id");--> statement-breakpoint
CREATE INDEX "chat_conversation_turns_thread_idx" ON "chat_conversation_turns" USING btree ("thread_id","id");--> statement-breakpoint
CREATE INDEX "chat_conversations_scope_updated_idx" ON "chat_conversations" USING btree ("scope_key","updated_at");