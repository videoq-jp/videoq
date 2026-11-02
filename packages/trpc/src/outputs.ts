import { qaOutputSchemas } from './qa';
import { z } from "zod";
import type { inputSchemas } from "./inputs";
import * as models from "./model-schemas";
import { videoListItemSchema, videoSchema } from "./schema";

const successSchema = z.object({ success: z.literal(true) });
const jobSchema = z.object({ job_id: z.string() });
const urlSchema = z.object({ url: z.string() });
const messageSchema = z.object({ message: z.string() });
const addedItemsSchema = messageSchema.extend({ added_count: z.number(), skipped_count: z.number() });

/** Runtime output validation and handler output types share this definition. */
export const outputSchemas = {
  ...qaOutputSchemas,
  "account.me": models.userSchema,
  "account.integrationApiKeys": z.array(z.object({
    id: z.string(), config_id: z.string(), name: z.string(),
    access_level: z.enum(["all", "read_only"]), prefix: z.string(),
    last_used_at: z.string().nullable(), created_at: z.string(),
  })),
  "account.connectedApps": z.array(z.object({
    id: z.string(), client_id: z.string(), client_name: z.string(),
    scope: z.string(), issued_at: z.string().nullable(),
  })),
  "account.searchApiKeyStatus": z.object({ has_api_key: z.boolean() }),
  "account.saveSearchApiKey": successSchema,
  "account.deleteSearchApiKey": successSchema,

  "admin.createUser": z.object({ id: z.string(), username: z.string(), email: z.email(), activation_url: z.url() }),
  "admin.resetAccess": z.object({ activation_url: z.url() }),
  "admin.listUsers": models.pageSchema(models.adminUserSchema),
  "admin.getUser": models.adminUserSchema,
  "admin.patchQuota": models.adminUserSchema,
  "admin.patchUsage": models.adminUserSchema,
  "admin.patchFlags": models.adminUserSchema,
  "admin.deleteUser": jobSchema,
  "admin.reindexAll": jobSchema,

  "billing.plans": z.array(models.billingPlanSchema),
  "billing.checkout": urlSchema,
  "billing.portal": urlSchema,

  "chat.conversations": z.object({ items: z.array(models.conversationSummarySchema), hasMore: z.boolean() }),
  "chat.conversation": models.conversationSchema,
  "chat.deleteConversation": successSchema,
  "chat.send": models.chatMessageSchema,
  "chat.feedback": z.object({ chat_log_id: z.number(), feedback: models.chatFeedbackSchema }),
  "chat.history": models.pageSchema(models.chatHistoryItemSchema),
  "chat.resetHistory": successSchema,
  "chat.analytics": models.chatAnalyticsSchema,

  "videos.list": models.pageSchema(videoListItemSchema),
  "videos.statusCounts": models.videoStatusCountsSchema,
  "videos.get": videoSchema,
  "videos.requestUpload": models.uploadRequestResponseSchema,
  "videos.confirmUpload": videoSchema,
  "videos.uploadPartUrl": z.object({ upload_url: z.string() }),
  "videos.completeMultipartUpload": videoSchema,
  "videos.abortUpload": z.object({ success: z.boolean() }),
  "videos.createYoutube": videoSchema,
  "videos.update": videoSchema,
  "videos.delete": successSchema,

  "courses.list": models.pageSchema(models.courseListItemSchema),
  "courses.get": models.courseSchema,
  "courses.shared": models.courseSchema,
  "courses.create": models.courseListItemSchema,
  "courses.update": models.courseSchema,
  "courses.delete": successSchema,
  "courses.reorder": z.object({ courseIds: z.array(z.number()) }),
  "courses.createShare": messageSchema.extend({ share_slug: z.string() }),
  "courses.deleteShare": successSchema,

  "courseMemberships.invite": z.object({ results: z.array(models.courseInviteRecipientResultSchema) }),
  "courseMemberships.participants": models.courseParticipantsSchema,
  "courseMemberships.preview": models.courseInvitationPreviewSchema,
  "courseMemberships.accept": z.object({ course_id: z.number(), status: z.literal("accepted") }),
  "courseMemberships.decline": z.object({ status: z.literal("declined") }),
  "courseMemberships.resend": z.object({ delivery_status: models.courseInvitationDeliveryStatusSchema, invitation_url: z.url().optional() }),
  "courseMemberships.revoke": successSchema,
  "courseMemberships.removeMember": successSchema,
  "courseMemberships.leave": successSchema,

  "memberships.addTags": addedItemsSchema,
  "memberships.removeTag": messageSchema,
  "memberships.reorderVideos": messageSchema,
  "memberships.addVideos": addedItemsSchema,
  "memberships.addVideo": messageSchema.extend({ id: z.number(), reused: z.boolean() }),
  "memberships.removeVideo": successSchema,

  "tags.list": models.pageSchema(models.tagSchema),
  "tags.get": models.tagDetailSchema,
  "tags.create": models.tagSchema,
  "tags.update": models.tagSchema,
  "tags.delete": successSchema,

} satisfies Record<keyof typeof inputSchemas, z.ZodType>;
