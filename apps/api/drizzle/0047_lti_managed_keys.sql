CREATE TABLE "lti_tool_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"encrypted_key_ring" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
