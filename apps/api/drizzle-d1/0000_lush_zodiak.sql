CREATE TABLE `account_deletion_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`reason` text NOT NULL,
	`requested_at` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_deletion_requests_user_id_idx` ON `account_deletion_requests` ("user_id" asc);--> statement-breakpoint
CREATE INDEX `account_deletion_requests_user_requested_idx` ON `account_deletion_requests` ("user_id" asc,"requested_at" desc);--> statement-breakpoint
CREATE TABLE `ai_answer_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`started_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`finished_at` text,
	`plan_code` text NOT NULL,
	`quota_source` text NOT NULL,
	`has_course` integer NOT NULL,
	`streamed` integer NOT NULL,
	`status` text NOT NULL,
	`quota_consumed` integer,
	`provider_calls` text DEFAULT '[]' NOT NULL,
	CONSTRAINT "ai_answer_attempts_status_check" CHECK(status IN ('started', 'completed', 'failed', 'interrupted'))
);
--> statement-breakpoint
CREATE INDEX `ai_answer_attempts_started_idx` ON `ai_answer_attempts` (`started_at`);--> statement-breakpoint
CREATE TABLE `chat_conversation_turns` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`checkpoint_id` text NOT NULL,
	`question` text NOT NULL,
	`response` text NOT NULL,
	`chat_log_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`chat_log_id`) REFERENCES `chat_logs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_conversations`(`thread_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `chat_conversation_turns_checkpoint_idx` ON `chat_conversation_turns` (`thread_id`,`checkpoint_id`);--> statement-breakpoint
CREATE INDEX `chat_conversation_turns_thread_idx` ON `chat_conversation_turns` (`thread_id`,`id`);--> statement-breakpoint
CREATE TABLE `chat_conversations` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`scope_key` text,
	`title` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`committed_checkpoint_id` text,
	`owner_user_id` text NOT NULL,
	`actor_user_id` text,
	`course_id` integer,
	`lease_id` text,
	`leased_until` text,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_conversations_expiry_idx` ON `chat_conversations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `chat_conversations_course_idx` ON `chat_conversations` (`course_id`);--> statement-breakpoint
CREATE INDEX `chat_conversations_scope_updated_idx` ON `chat_conversations` (`scope_key`,`updated_at`);--> statement-breakpoint
CREATE TABLE `chat_log_evaluations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text NOT NULL,
	`faithfulness` real,
	`answer_relevancy` real,
	`context_precision` real,
	`error_message` text NOT NULL,
	`evaluated_at` text,
	`created_at` text NOT NULL,
	`chat_log_id` integer NOT NULL,
	FOREIGN KEY (`chat_log_id`) REFERENCES `chat_logs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_log_evaluations_status_idx` ON `chat_log_evaluations` ("status" asc);--> statement-breakpoint
CREATE UNIQUE INDEX `chat_log_evaluations_chat_log_id_key` ON `chat_log_evaluations` (`chat_log_id`);--> statement-breakpoint
CREATE TABLE `chat_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`question` text NOT NULL,
	`response` text NOT NULL,
	`is_shared_origin` integer NOT NULL,
	`feedback` text,
	`created_at` text NOT NULL,
	`user_id` text NOT NULL,
	`course_id` integer NOT NULL,
	`retrieved_contexts` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_logs_user_id_idx` ON `chat_logs` ("user_id" asc);--> statement-breakpoint
CREATE INDEX `chat_logs_course_id_idx` ON `chat_logs` ("course_id" asc);--> statement-breakpoint
CREATE INDEX `chat_logs_course_created_idx` ON `chat_logs` ("course_id" asc,"created_at" desc);--> statement-breakpoint
CREATE TABLE `course_evaluation_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sample_count` integer NOT NULL,
	`faithfulness_mean` real,
	`answer_relevancy_mean` real,
	`samples` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`course_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`context_precision_mean` real,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `course_evaluation_snapshots_user_id_idx` ON `course_evaluation_snapshots` ("user_id" asc);--> statement-breakpoint
CREATE UNIQUE INDEX `course_evaluation_snapshots_course_id_key` ON `course_evaluation_snapshots` (`course_id`);--> statement-breakpoint
CREATE TABLE `course_qa_moderation` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`question_id` text NOT NULL,
	`reply_id` text,
	`actor_user_id` text,
	`lti_actor_id` text,
	`action` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`actor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "course_qa_moderation_actor_kind" CHECK("course_qa_moderation"."actor_user_id" IS NULL OR "course_qa_moderation"."lti_actor_id" IS NULL),
	CONSTRAINT "course_qa_moderation_lti_actor_format" CHECK("course_qa_moderation"."lti_actor_id" IS NULL OR (length("course_qa_moderation"."lti_actor_id") = 64 AND "course_qa_moderation"."lti_actor_id" NOT GLOB '*[^a-f0-9]*')),
	CONSTRAINT "course_qa_moderation_action" CHECK("course_qa_moderation"."action" IN ('feature', 'unfeature', 'delete_question', 'delete_reply'))
);
--> statement-breakpoint
CREATE INDEX `course_qa_moderation_course_idx` ON `course_qa_moderation` (`course_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `course_qa_moderation_lti_actor_idx` ON `course_qa_moderation` (`lti_actor_id`);--> statement-breakpoint
CREATE INDEX `course_qa_moderation_retention_idx` ON `course_qa_moderation` (`created_at`,`id`) WHERE "course_qa_moderation"."lti_actor_id" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `course_question_lti_votes` (
	`question_id` text NOT NULL,
	`lti_author_id` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`question_id`, `lti_author_id`),
	FOREIGN KEY (`question_id`) REFERENCES `course_questions`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "course_question_lti_votes_author_format" CHECK((length("course_question_lti_votes"."lti_author_id") = 64 AND "course_question_lti_votes"."lti_author_id" NOT GLOB '*[^a-f0-9]*'))
);
--> statement-breakpoint
CREATE INDEX `course_question_lti_votes_author_idx` ON `course_question_lti_votes` (`lti_author_id`);--> statement-breakpoint
CREATE TABLE `course_question_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`author_id` text,
	`lti_author_id` text,
	`lti_instructor` integer DEFAULT false NOT NULL,
	`body` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `course_questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "course_question_replies_body_length" CHECK(length("course_question_replies"."body") BETWEEN 1 AND 10000),
	CONSTRAINT "course_question_replies_author_kind" CHECK("course_question_replies"."author_id" IS NULL OR "course_question_replies"."lti_author_id" IS NULL),
	CONSTRAINT "course_question_replies_lti_author_format" CHECK("course_question_replies"."lti_author_id" IS NULL OR (length("course_question_replies"."lti_author_id") = 64 AND "course_question_replies"."lti_author_id" NOT GLOB '*[^a-f0-9]*'))
);
--> statement-breakpoint
CREATE INDEX `course_question_replies_question_idx` ON `course_question_replies` (`question_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `course_question_replies_lti_author_idx` ON `course_question_replies` (`lti_author_id`);--> statement-breakpoint
CREATE TABLE `course_question_votes` (
	`question_id` text NOT NULL,
	`user_id` text NOT NULL,
	PRIMARY KEY(`question_id`, `user_id`),
	FOREIGN KEY (`question_id`) REFERENCES `course_questions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `course_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`video_id` integer,
	`source_video_id` integer,
	`author_id` text,
	`lti_author_id` text,
	`lti_instructor` integer DEFAULT false NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`featured` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`author_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "course_questions_body_length" CHECK(length("course_questions"."body") BETWEEN 1 AND 10000),
	CONSTRAINT "course_questions_author_kind" CHECK("course_questions"."author_id" IS NULL OR "course_questions"."lti_author_id" IS NULL),
	CONSTRAINT "course_questions_lti_author_format" CHECK("course_questions"."lti_author_id" IS NULL OR (length("course_questions"."lti_author_id") = 64 AND "course_questions"."lti_author_id" NOT GLOB '*[^a-f0-9]*')),
	CONSTRAINT "course_questions_source_positive" CHECK("course_questions"."source_video_id" IS NULL OR "course_questions"."source_video_id" > 0)
);
--> statement-breakpoint
CREATE INDEX `course_questions_course_created_idx` ON `course_questions` (`course_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `course_questions_video_idx` ON `course_questions` (`course_id`,`video_id`);--> statement-breakpoint
CREATE INDEX `course_questions_lti_author_idx` ON `course_questions` (`lti_author_id`,`course_id`);--> statement-breakpoint
CREATE TABLE `external_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`available_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`locked_at` text,
	`completed_at` text,
	`dead_at` text,
	`effect_applied_at` text,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "external_tasks_kind_check" CHECK(kind IN ('sqs_job', 'storage_cleanup', 'invitation_email')),
	CONSTRAINT "external_tasks_attempts_check" CHECK(attempts >= 0)
);
--> statement-breakpoint
CREATE INDEX `external_tasks_video_job_idx` ON `external_tasks` (("payload" ->> '$.message.payload.video_id'),`created_at`) WHERE "external_tasks"."kind" = 'sqs_job';--> statement-breakpoint
CREATE INDEX `external_tasks_ready_idx` ON `external_tasks` (`available_at`,`id`) WHERE completed_at IS NULL AND dead_at IS NULL;--> statement-breakpoint
CREATE INDEX `external_tasks_completed_idx` ON `external_tasks` (`completed_at`,`id`) WHERE completed_at IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `external_tasks_dedupe_key_key` ON `external_tasks` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `job_executions` (
	`job_id` text PRIMARY KEY NOT NULL,
	`job_type` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`completed_at` text,
	`last_error` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	CONSTRAINT "job_executions_status_check" CHECK(status IN ('running', 'failed', 'completed')),
	CONSTRAINT "job_executions_attempts_check" CHECK(attempts >= 0)
);
--> statement-breakpoint
CREATE INDEX `job_executions_completed_idx` ON `job_executions` (`completed_at`,`job_id`) WHERE completed_at IS NOT NULL;--> statement-breakpoint
CREATE TABLE `lti_chat_log_subjects` (
	`chat_log_id` integer PRIMARY KEY NOT NULL,
	`subject_key` text NOT NULL,
	`resource_video_ids` text NOT NULL,
	`registration_id` text,
	`context_id` text,
	FOREIGN KEY (`chat_log_id`) REFERENCES `chat_logs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lti_chat_log_subjects_key_format" CHECK((length("lti_chat_log_subjects"."subject_key") = 64 AND "lti_chat_log_subjects"."subject_key" NOT GLOB '*[^a-f0-9]*')),
	CONSTRAINT "lti_chat_log_subjects_resources_array" CHECK(json_type("lti_chat_log_subjects"."resource_video_ids") = 'array')
);
--> statement-breakpoint
CREATE INDEX `lti_chat_log_subjects_subject_idx` ON `lti_chat_log_subjects` (`subject_key`,`chat_log_id`);--> statement-breakpoint
CREATE INDEX `lti_chat_log_subjects_report_idx` ON `lti_chat_log_subjects` (`registration_id`,`context_id`,`chat_log_id`);--> statement-breakpoint
CREATE TABLE `lti_conversation_scopes` (
	`thread_id` text PRIMARY KEY NOT NULL,
	`subject_key` text NOT NULL,
	`resource_video_ids` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_conversations`(`thread_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lti_conversation_scopes_key_format" CHECK((length("lti_conversation_scopes"."subject_key") = 64 AND "lti_conversation_scopes"."subject_key" NOT GLOB '*[^a-f0-9]*')),
	CONSTRAINT "lti_conversation_scopes_resources_array" CHECK(json_type("lti_conversation_scopes"."resource_video_ids") = 'array')
);
--> statement-breakpoint
CREATE INDEX `lti_conversation_scopes_subject_idx` ON `lti_conversation_scopes` (`subject_key`,`thread_id`);--> statement-breakpoint
CREATE TABLE `lti_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `lti_credentials_expiry_idx` ON `lti_credentials` (`expires_at`);--> statement-breakpoint
CREATE TABLE `mcp_idempotency_records` (
	`user_id` text NOT NULL,
	`action` text NOT NULL,
	`key` text NOT NULL,
	`request_hash` text NOT NULL,
	`resource_id` integer NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`user_id`, `action`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "mcp_idempotency_records_action_check" CHECK(action IN ('request_video_upload', 'create_youtube_video', 'create_course')),
	CONSTRAINT "mcp_idempotency_records_request_hash_check" CHECK((length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'))
);
--> statement-breakpoint
CREATE INDEX `mcp_idempotency_records_created_at_idx` ON `mcp_idempotency_records` (`created_at`);--> statement-breakpoint
CREATE TABLE `runtime_rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`history` text DEFAULT '[]' NOT NULL,
	`window_sec` integer NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `runtime_rate_limits_expiry_idx` ON `runtime_rate_limits` (`expires_at`);--> statement-breakpoint
CREATE TABLE `stripe_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`processed_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`created_at` text NOT NULL,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tags_user_id_idx` ON `tags` ("user_id" asc);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_user_id_name_uniq` ON `tags` (`name`,`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`username` text NOT NULL,
	`display_username` text,
	`role` text DEFAULT 'user' NOT NULL,
	`banned` integer DEFAULT false,
	`ban_reason` text,
	`ban_expires` text,
	`last_login` text,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`date_joined` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`deactivated_at` text,
	`max_video_upload_size_mb` integer DEFAULT 0 NOT NULL,
	`searchapi_api_key_encrypted` text,
	`ai_answers_limit` integer,
	`is_over_quota` integer NOT NULL,
	`processing_limit_minutes` integer,
	`storage_limit_gb` real,
	`monthly_upload_limit_gb` real DEFAULT 2,
	`used_upload_bytes` integer DEFAULT 0 NOT NULL,
	`upload_usage_period_start` text,
	`usage_period_start` text,
	`used_ai_answers` integer NOT NULL,
	`used_processing_seconds` integer NOT NULL,
	`used_storage_bytes` integer NOT NULL,
	`pending_email` text,
	`password_reset_required` integer DEFAULT true NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`plan_code` text DEFAULT 'free' NOT NULL,
	`subscription_status` text,
	`quota_source` text DEFAULT 'plan' NOT NULL,
	CONSTRAINT "users_max_video_upload_size_mb_check" CHECK(max_video_upload_size_mb >= 0),
	CONSTRAINT "users_monthly_upload_limit_check" CHECK(monthly_upload_limit_gb >= 0),
	CONSTRAINT "users_used_upload_bytes_check" CHECK(used_upload_bytes >= 0),
	CONSTRAINT "users_plan_code_check" CHECK(plan_code IN ('free', 'basic', 'pro')),
	CONSTRAINT "users_quota_source_check" CHECK(quota_source IN ('plan', 'admin'))
);
--> statement-breakpoint
CREATE INDEX `users_email_active_idx` ON `users` ("email" asc,"is_active" asc);--> statement-breakpoint
CREATE INDEX `users_deactivated_at_idx` ON `users` ("deactivated_at" asc);--> statement-breakpoint
CREATE INDEX `users_stripe_customer_id_idx` ON `users` ("stripe_customer_id" asc);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_key` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_key` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_stripe_customer_id_key` ON `users` (`stripe_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_stripe_subscription_id_key` ON `users` (`stripe_subscription_id`);--> statement-breakpoint
CREATE TABLE `video_course_invitations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`course_id` integer NOT NULL,
	`email` text NOT NULL,
	`invited_by_user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`delivery_status` text DEFAULT 'queued' NOT NULL,
	`token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`accepted_by_user_id` text,
	`accepted_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_sent_at` text,
	`send_attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`accepted_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "video_course_invitations_status_check" CHECK(status IN ('pending', 'accepted', 'declined', 'expired', 'revoked')),
	CONSTRAINT "video_course_invitations_delivery_status_check" CHECK(delivery_status IN ('queued', 'sent', 'failed')),
	CONSTRAINT "video_course_invitations_send_attempts_check" CHECK(send_attempts >= 0)
);
--> statement-breakpoint
CREATE INDEX `video_course_invitations_course_status_idx` ON `video_course_invitations` ("course_id" asc,"status" asc);--> statement-breakpoint
CREATE INDEX `video_course_invitations_email_idx` ON `video_course_invitations` ("email" asc);--> statement-breakpoint
CREATE UNIQUE INDEX `video_course_invitations_pending_email_uniq` ON `video_course_invitations` (`course_id`,`email`) WHERE status = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `video_course_invitations_token_hash_key` ON `video_course_invitations` (`token_hash`);--> statement-breakpoint
CREATE TABLE `video_course_members` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`added_at` text NOT NULL,
	`order` integer NOT NULL,
	`course_id` integer NOT NULL,
	`video_id` integer NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `video_course_members_course_id_idx` ON `video_course_members` ("course_id" asc);--> statement-breakpoint
CREATE INDEX `video_course_members_video_id_idx` ON `video_course_members` ("video_id" asc);--> statement-breakpoint
CREATE INDEX `video_course_members_course_order_idx` ON `video_course_members` ("course_id" asc,"order" asc);--> statement-breakpoint
CREATE UNIQUE INDEX `video_course_members_course_video_uniq` ON `video_course_members` (`course_id`,`video_id`);--> statement-breakpoint
CREATE TABLE `video_course_memberships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`course_id` integer NOT NULL,
	`user_id` text NOT NULL,
	`invitation_id` integer,
	`joined_at` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invitation_id`) REFERENCES `video_course_invitations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `video_course_memberships_course_id_idx` ON `video_course_memberships` ("course_id" asc);--> statement-breakpoint
CREATE INDEX `video_course_memberships_user_id_idx` ON `video_course_memberships` ("user_id" asc);--> statement-breakpoint
CREATE UNIQUE INDEX `video_course_memberships_course_user_uniq` ON `video_course_memberships` (`course_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `video_course_memberships_invitation_id_key` ON `video_course_memberships` (`invitation_id`);--> statement-breakpoint
CREATE TABLE `video_courses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`user_id` text NOT NULL,
	`share_slug` text,
	`managed_by_lms` integer DEFAULT false NOT NULL,
	`native_access_disabled` integer DEFAULT false NOT NULL,
	`display_order` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `video_courses_user_id_idx` ON `video_courses` ("user_id" asc);--> statement-breakpoint
CREATE INDEX `video_courses_share_slug_idx` ON `video_courses` ("share_slug" asc) WHERE (share_slug IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX `video_courses_share_slug_ci_uniq` ON `video_courses` (lower((share_slug))) WHERE (share_slug IS NOT NULL);--> statement-breakpoint
CREATE TABLE `video_tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`added_at` text NOT NULL,
	`tag_id` integer NOT NULL,
	`video_id` integer NOT NULL,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `video_tags_tag_id_idx` ON `video_tags` ("tag_id" asc);--> statement-breakpoint
CREATE INDEX `video_tags_video_id_idx` ON `video_tags` ("video_id" asc);--> statement-breakpoint
CREATE UNIQUE INDEX `video_tags_video_tag_uniq` ON `video_tags` (`tag_id`,`video_id`);--> statement-breakpoint
CREATE TABLE `video_transcription_chunks` (
	`run_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`segments` text,
	`fallback_segments` text DEFAULT '{}' NOT NULL,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`run_id`, `chunk_index`),
	FOREIGN KEY (`run_id`) REFERENCES `video_transcription_runs`(`run_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "video_transcription_chunks_index_check" CHECK("video_transcription_chunks"."chunk_index" >= 0),
	CONSTRAINT "video_transcription_chunks_failures_check" CHECK("video_transcription_chunks"."failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE `video_transcription_runs` (
	`video_id` integer PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`file_key` text NOT NULL,
	`transcript_hash` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`chunk_seconds` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "video_transcription_runs_duration_check" CHECK("video_transcription_runs"."duration_ms" > 0),
	CONSTRAINT "video_transcription_runs_chunks_check" CHECK("video_transcription_runs"."chunk_seconds" > 0 AND "video_transcription_runs"."chunk_count" BETWEEN 1 AND 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_transcription_runs_run_id_unique` ON `video_transcription_runs` (`run_id`);--> statement-breakpoint
CREATE TABLE `video_visual_chunks` (
	`run_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`frame_count` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	PRIMARY KEY(`run_id`, `chunk_index`),
	FOREIGN KEY (`run_id`) REFERENCES `video_visual_runs`(`run_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "video_visual_chunks_index_check" CHECK("video_visual_chunks"."chunk_index" BETWEEN 0 AND 599),
	CONSTRAINT "video_visual_chunks_frames_check" CHECK("video_visual_chunks"."frame_count" IS NULL OR "video_visual_chunks"."frame_count" BETWEEN 0 AND 60),
	CONSTRAINT "video_visual_chunks_failures_check" CHECK("video_visual_chunks"."failures" >= 0)
);
--> statement-breakpoint
CREATE TABLE `video_visual_runs` (
	`video_id` integer PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`file_key` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`chunk_count` integer NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "video_visual_runs_duration_check" CHECK("video_visual_runs"."duration_ms" > 0 AND "video_visual_runs"."duration_ms" <= 36000000),
	CONSTRAINT "video_visual_runs_chunks_check" CHECK("video_visual_runs"."chunk_count" BETWEEN 1 AND 600),
	CONSTRAINT "video_visual_runs_status_check" CHECK("video_visual_runs"."status" IN ('processing', 'ready', 'error'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `video_visual_runs_run_id_unique` ON `video_visual_runs` (`run_id`);--> statement-breakpoint
CREATE TABLE `videos` (
	`managed_by_lms` integer DEFAULT false NOT NULL,
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`transcription_language` text,
	`file` text NOT NULL,
	`multipart_upload` text,
	`upload_heartbeat_at` text,
	`upload_usage_period_start` text,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`uploaded_at` text NOT NULL,
	`transcript` text NOT NULL,
	`status` text NOT NULL,
	`error_message` text NOT NULL,
	`processing_seconds` integer DEFAULT 0 NOT NULL,
	`user_id` text NOT NULL,
	`source_type` text NOT NULL,
	`source_url` text NOT NULL,
	`youtube_video_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "videos_processing_seconds_check" CHECK(processing_seconds >= 0)
);
--> statement-breakpoint
CREATE INDEX `videos_user_id_idx` ON `videos` ("user_id" asc);--> statement-breakpoint
CREATE INDEX `videos_status_idx` ON `videos` ("status" asc);--> statement-breakpoint
CREATE INDEX `videos_uploaded_at_idx` ON `videos` ("uploaded_at" asc);--> statement-breakpoint
CREATE INDEX `videos_user_status_uploaded_idx` ON `videos` ("user_id" asc,"status" asc,"uploaded_at" desc);--> statement-breakpoint
CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`issuer` text,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` text,
	`refresh_token_expires_at` text,
	`scope` text,
	`password` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_user_id_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE INDEX `account_provider_account_id_idx` ON `account` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `apikey` (
	`id` text PRIMARY KEY NOT NULL,
	`config_id` text DEFAULT 'default' NOT NULL,
	`name` text,
	`start` text,
	`reference_id` text NOT NULL,
	`prefix` text,
	`key` text NOT NULL,
	`refill_interval` integer,
	`refill_amount` integer,
	`last_refill_at` text,
	`enabled` integer DEFAULT true NOT NULL,
	`rate_limit_enabled` integer,
	`rate_limit_time_window` integer,
	`rate_limit_max` integer,
	`request_count` integer,
	`remaining` integer,
	`last_request` text,
	`expires_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`permissions` text,
	`metadata` text
);
--> statement-breakpoint
CREATE INDEX `apikey_reference_id_idx` ON `apikey` (`reference_id`);--> statement-breakpoint
CREATE INDEX `apikey_key_idx` ON `apikey` (`key`);--> statement-breakpoint
CREATE TABLE `device_code` (
	`id` text PRIMARY KEY NOT NULL,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` text NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` text,
	`polling_interval` integer,
	`client_id` text,
	`scope` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_device_code_uidx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE INDEX `device_code_user_code_idx` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE TABLE `jwks` (
	`id` text PRIMARY KEY NOT NULL,
	`public_key` text NOT NULL,
	`private_key` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`expires_at` text,
	`alg` text,
	`crv` text
);
--> statement-breakpoint
CREATE TABLE `oauth_access_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`refresh_id` text,
	`expires_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	`revoked` text,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`refresh_id`) REFERENCES `oauth_refresh_token`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_access_token_token_unique` ON `oauth_access_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauth_access_token_user_id_idx` ON `oauth_access_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_access_token_client_id_idx` ON `oauth_access_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_access_token_session_id_idx` ON `oauth_access_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauth_access_token_authorization_code_id_idx` ON `oauth_access_token` (`authorization_code_id`);--> statement-breakpoint
CREATE INDEX `oauth_access_token_refresh_id_idx` ON `oauth_access_token` (`refresh_id`);--> statement-breakpoint
CREATE TABLE `oauth_client` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`client_secret` text,
	`client_discovery_id` text,
	`disabled` integer DEFAULT false,
	`skip_consent` integer,
	`enable_end_session` integer,
	`subject_type` text,
	`scopes` text,
	`client_credentials_scopes` text,
	`user_id` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	`name` text,
	`uri` text,
	`icon` text,
	`contacts` text,
	`tos` text,
	`policy` text,
	`software_id` text,
	`software_version` text,
	`software_statement` text,
	`redirect_uris` text NOT NULL,
	`post_logout_redirect_uris` text,
	`backchannel_logout_uri` text,
	`backchannel_logout_session_required` integer,
	`token_endpoint_auth_method` text,
	`application_type` text,
	`client_jwks` text,
	`jwks_uri` text,
	`grant_types` text,
	`response_types` text,
	`public` integer,
	`type` text,
	`require_pkce` integer,
	`dpop_bound_access_tokens` integer DEFAULT false NOT NULL,
	`reference_id` text,
	`metadata` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_client_id_unique` ON `oauth_client` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_client_user_id_idx` ON `oauth_client` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_client_assertion` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_client_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `oauth_resource`(`identifier`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_client_resource_client_id_idx` ON `oauth_client_resource` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_client_resource_resource_id_idx` ON `oauth_client_resource` (`resource_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_client_resource_client_resource_uidx` ON `oauth_client_resource` (`client_id`,`resource_id`);--> statement-breakpoint
CREATE TABLE `oauth_consent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`reference_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`scopes` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `oauth_consent_user_id_idx` ON `oauth_consent` (`user_id`);--> statement-breakpoint
CREATE TABLE `oauth_refresh_token` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`client_id` text NOT NULL,
	`session_id` text,
	`user_id` text NOT NULL,
	`reference_id` text,
	`authorization_code_id` text,
	`resources` text,
	`requested_user_info_claims` text,
	`expires_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	`revoked` text,
	`rotated_at` text,
	`rotation_replay_response` text,
	`rotation_replay_expires_at` text,
	`auth_time` text,
	`confirmation` text,
	`scopes` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_refresh_token_token_unique` ON `oauth_refresh_token` (`token`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_token_user_id_idx` ON `oauth_refresh_token` (`user_id`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_token_client_id_idx` ON `oauth_refresh_token` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_token_session_id_idx` ON `oauth_refresh_token` (`session_id`);--> statement-breakpoint
CREATE INDEX `oauth_refresh_token_authorization_code_id_idx` ON `oauth_refresh_token` (`authorization_code_id`);--> statement-breakpoint
CREATE TABLE `oauth_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer DEFAULT false NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
	`policy_version` integer DEFAULT 1 NOT NULL,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_resource_identifier_key` ON `oauth_resource` (`identifier`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL,
	`token` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	`impersonated_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_user_id_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lms_courses` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`context_id` text NOT NULL,
	`course_id` integer NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `lms_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lms_courses_context_key` ON `lms_courses` (`installation_id`,`context_id`);--> statement-breakpoint
CREATE TABLE `lms_installations` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`issuer` text NOT NULL,
	`client_id` text NOT NULL,
	`deployment_id` text NOT NULL,
	`authorization_url` text NOT NULL,
	`jwks_url` text NOT NULL,
	`sync_token_hash` text,
	`materials_service` text,
	`next_materials_sync_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	`materials_cursor` integer DEFAULT 0 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lms_installations_auth_mode_check" CHECK(("lms_installations"."materials_service" IS NULL AND "lms_installations"."sync_token_hash" IS NOT NULL) OR ("lms_installations"."materials_service" IS NOT NULL AND "lms_installations"."sync_token_hash" IS NULL)),
	CONSTRAINT "lms_installations_token_hash_check" CHECK((length("lms_installations"."sync_token_hash") = 64 AND "lms_installations"."sync_token_hash" NOT GLOB '*[^a-f0-9]*'))
);
--> statement-breakpoint
CREATE INDEX `lms_installations_owner_idx` ON `lms_installations` (`owner_user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lms_installations_identity_key` ON `lms_installations` (`issuer`,`client_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lms_installations_sync_token_key` ON `lms_installations` (`sync_token_hash`);--> statement-breakpoint
CREATE TABLE `lms_resources` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text DEFAULT 'video' NOT NULL,
	`context_id` text NOT NULL,
	`resource_link_id` text NOT NULL,
	`generation` integer NOT NULL,
	`manifest_hash` text NOT NULL,
	`enabled` integer NOT NULL,
	`content_hash` text,
	`content_type` text,
	`file_size` integer,
	`youtube_video_id` text,
	`course_id` integer,
	`video_id` integer,
	`sync_error` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `lms_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "lms_resources_generation_check" CHECK("lms_resources"."generation" > 0),
	CONSTRAINT "lms_resources_kind_check" CHECK("lms_resources"."kind" IN ('video','course','youtube')),
	CONSTRAINT "lms_resources_course_media_check" CHECK("lms_resources"."kind" <> 'course' OR ("lms_resources"."video_id" IS NULL AND "lms_resources"."content_hash" IS NULL AND "lms_resources"."content_type" IS NULL AND "lms_resources"."file_size" IS NULL)),
	CONSTRAINT "lms_resources_youtube_check" CHECK(("lms_resources"."kind" = 'youtube' AND "lms_resources"."content_hash" IS NULL AND "lms_resources"."content_type" IS NULL AND "lms_resources"."file_size" IS NULL AND ("lms_resources"."youtube_video_id" IS NULL OR ((length("lms_resources"."youtube_video_id") = 11 AND "lms_resources"."youtube_video_id" NOT GLOB '*[^A-Za-z0-9_-]*') AND "lms_resources"."youtube_video_id" GLOB '*[A-Za-z0-9]*')) AND (NOT "lms_resources"."enabled" OR "lms_resources"."youtube_video_id" IS NOT NULL)) OR ("lms_resources"."kind" <> 'youtube' AND "lms_resources"."youtube_video_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lms_resources_course_entry_key` ON `lms_resources` (`installation_id`,`context_id`) WHERE "lms_resources"."kind" = 'course';--> statement-breakpoint
CREATE UNIQUE INDEX `lms_resources_external_key` ON `lms_resources` (`installation_id`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `lms_resources_launch_key` ON `lms_resources` (`installation_id`,`context_id`,`resource_link_id`);--> statement-breakpoint
CREATE TABLE `lti_course_tag_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`actor_key` text NOT NULL,
	`action` text NOT NULL,
	`request_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lti_course_tag_ops_action_check" CHECK("lti_course_tag_operations"."action" IN ('create','update','delete','assign')),
	CONSTRAINT "lti_course_tag_ops_actor_check" CHECK((length("lti_course_tag_operations"."actor_key") = 64 AND "lti_course_tag_operations"."actor_key" NOT GLOB '*[^a-f0-9]*'))
);
--> statement-breakpoint
CREATE INDEX `lti_course_tag_ops_course_idx` ON `lti_course_tag_operations` (`course_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `lti_course_tag_ops_retention_idx` ON `lti_course_tag_operations` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `lti_course_tags` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` integer NOT NULL,
	`name` text NOT NULL,
	`color` text NOT NULL,
	`revision` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lti_course_tags_name_key` ON `lti_course_tags` (`course_id`,`name`);--> statement-breakpoint
CREATE TABLE `lti_course_video_tags` (
	`tag_id` text NOT NULL,
	`video_id` integer NOT NULL,
	PRIMARY KEY(`tag_id`, `video_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `lti_course_tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `lti_course_video_tags_video_idx` ON `lti_course_video_tags` (`video_id`);--> statement-breakpoint
CREATE TABLE `lti_material_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`video_id` integer,
	`course_id` integer NOT NULL,
	`source_generation` integer NOT NULL,
	`actor_key` text NOT NULL,
	`action` text NOT NULL,
	`request_hash` text NOT NULL,
	`before_revision` text NOT NULL,
	`after_revision` text NOT NULL,
	`external_task_id` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `lms_resources`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`external_task_id`) REFERENCES `external_tasks`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "lti_material_ops_action_check" CHECK("lti_material_operations"."action" IN ('update','reindex','retry')),
	CONSTRAINT "lti_material_ops_actor_check" CHECK((length("lti_material_operations"."actor_key") = 64 AND "lti_material_operations"."actor_key" NOT GLOB '*[^a-f0-9]*'))
);
--> statement-breakpoint
CREATE INDEX `lti_material_ops_resource_created_idx` ON `lti_material_operations` (`resource_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `lti_material_ops_actor_idx` ON `lti_material_operations` (`actor_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `lti_material_ops_retention_idx` ON `lti_material_operations` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `lti_operation_reservations` (
	`key` text PRIMARY KEY NOT NULL,
	CONSTRAINT "lti_operation_reservation_key_format" CHECK((length("lti_operation_reservations"."key") = 64 AND "lti_operation_reservations"."key" NOT GLOB '*[^a-f0-9]*'))
);
--> statement-breakpoint
CREATE TABLE `lti_report_accesses` (
	`id` text PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`course_id` integer NOT NULL,
	`context_id` text NOT NULL,
	`actor_key` text NOT NULL,
	`from_date` text NOT NULL,
	`to_date` text NOT NULL,
	`resource_count` integer NOT NULL,
	`scope_hash` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`installation_id`) REFERENCES `lms_installations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`course_id`) REFERENCES `video_courses`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "lti_report_accesses_actor_check" CHECK((length("lti_report_accesses"."actor_key") = 64 AND "lti_report_accesses"."actor_key" NOT GLOB '*[^a-f0-9]*')),
	CONSTRAINT "lti_report_accesses_scope_check" CHECK((length("lti_report_accesses"."scope_hash") = 64 AND "lti_report_accesses"."scope_hash" NOT GLOB '*[^a-f0-9]*')),
	CONSTRAINT "lti_report_accesses_count_check" CHECK("lti_report_accesses"."resource_count" BETWEEN 0 AND 1000),
	CONSTRAINT "lti_report_accesses_period_check" CHECK("lti_report_accesses"."to_date" >= "lti_report_accesses"."from_date" AND julianday("lti_report_accesses"."to_date") - julianday("lti_report_accesses"."from_date") < 366)
);
--> statement-breakpoint
CREATE INDEX `lti_report_accesses_actor_idx` ON `lti_report_accesses` (`actor_key`,`course_id`,`id`);--> statement-breakpoint
CREATE INDEX `lti_report_accesses_retention_idx` ON `lti_report_accesses` (`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `lti_tool_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`encrypted_key_ring` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scenes` (
	`id` text PRIMARY KEY NOT NULL,
	`video_id` integer NOT NULL,
	`content` text NOT NULL,
	`start_time` text NOT NULL,
	`end_time` text NOT NULL,
	`evidence_type` text DEFAULT 'transcript' NOT NULL,
	`dimensions` integer NOT NULL,
	`revision` text NOT NULL,
	FOREIGN KEY (`video_id`) REFERENCES `videos`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "scenes_dimensions_check" CHECK("scenes"."dimensions" IN (768, 1536)),
	CONSTRAINT "scenes_evidence_type_check" CHECK("scenes"."evidence_type" IN ('transcript', 'visual')),
	CONSTRAINT "scenes_id_length_check" CHECK(length(CAST("scenes"."id" AS BLOB)) BETWEEN 1 AND 64)
);
--> statement-breakpoint
CREATE INDEX `scenes_video_idx` ON `scenes` (`video_id`);