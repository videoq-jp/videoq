import type { ChatAnswer, ChatSource } from "../../application/models";
import type { LtiSessionProof } from "../../application/lti-session-proof";
import type {
  AiAnswerReservation,
  AiAnswerReservationResult,
} from "../../persistence/contracts/ai-quota";
import type {
  ChatContextInput,
  GroupChatContext,
  CreateChatLogInput,
} from "../../persistence/contracts/chat-repository";
import type { LtiDataSubject } from "../../persistence/contracts/lti-subject";
import type { ConversationScope } from "../../persistence/contracts/conversation-read";

export type ChatRequestInput = {
  messages: { role: string; content: string }[];
  courseId: number | null;
  conversationId?: string;
  resumeConversation?: boolean;
};
export type ChatFailure = {
  kind: "invalid" | "forbidden" | "missing" | "internal";
  streamCode: string;
  code: string;
  message: string;
};
export type ChatMessage = {
  role: "assistant";
  answer: ChatAnswer;
  chatLogId?: number;
  feedback?: "good" | "bad" | null;
  feedbackToken?: string;
};
export type GeneratedAnswer = {
  queryText: string;
  answer: ChatAnswer;
  retrievedContexts: string[];
  persistedTurn?: { chatLogId: number | null; feedback: string | null };
};
export type ToolProgress = {
  type: "tool_progress";
  call_id: number;
  tool:
    | "get_course_info"
    | "search_scenes"
    | "overview_video"
    | "skim_video"
    | "read_video_window"
    | "inspect_clip"
    | "focus_clip";
  status: "running" | "complete" | "error";
};
export type AnswerPart =
  | { type: "text"; segmentIndex: number; text: string }
  | { type: "citation"; segmentIndex: number; sourceId: number };
export type GenerationChunk =
  | { part: AnswerPart }
  | { source: ChatSource }
  | { toolProgress: ToolProgress }
  | { searching: string; searchId: number }
  | { searchCompleted: { id: number; query: string; count: number } }
  | { final: GeneratedAnswer };
export type ChatGenerationEvent =
  | AnswerPart
  | ToolProgress
  | { type: "source"; source: ChatSource }
  | { type: "searching"; query: string; searchId: number }
  | { type: "searchCompleted"; query: string; searchId: number; count: number }
  | { type: "error"; failure: ChatFailure }
  | {
      type: "done";
      chatLogId: number | null;
      feedback: "good" | "bad" | null;
      feedbackToken?: string;
    };
export type GenerationParams<Ledger> = {
  messages: readonly { role: string; content: string }[];
  ownerUserId: string;
  videoIds: readonly number[] | null;
  locale: string | null;
  courseId: number | null;
  costLedger: Ledger;
};
export type GenerationConversation = {
  id?: string;
  resume?: boolean;
  question?: string;
  scope: ConversationScope;
  persistLog: (answer: GeneratedAnswer) => CreateChatLogInput | null;
};
export interface ChatGenerationDependencies<Ledger> {
  context(input: ChatContextInput): Promise<GroupChatContext | null>;
  checkedLtiSubject(subject: LtiDataSubject): LtiDataSubject;
  reserve(userId: string): Promise<AiAnswerReservationResult>;
  /** Best effort adapters report failures without replacing the answer outcome. */
  release(reservation: AiAnswerReservation): Promise<void>;
  createLog(
    input: CreateChatLogInput,
  ): Promise<{ id: number; feedback: string | null }>;
  startCost(
    reservation: AiAnswerReservation,
    hasCourse: boolean,
    streamed: boolean,
  ): Promise<Ledger>;
  finishCost(
    ledger: Ledger,
    status: "completed" | "failed" | "interrupted",
    consumed: boolean,
  ): Promise<void>;
  run(
    params: GenerationParams<Ledger>,
    conversation: GenerationConversation,
  ): Promise<GeneratedAnswer>;
  stream(
    params: GenerationParams<Ledger>,
    conversation: GenerationConversation,
    signal?: AbortSignal,
  ): AsyncIterable<GenerationChunk>;
  isCommittedFailure(error: unknown): boolean;
  classifyFailure(error: unknown): ChatFailure;
  feedbackToken(logId: number, shareSlug: string): Promise<string>;
}
export type ChatGenerationOptions = {
  userId: string | null;
  request: ChatRequestInput;
  visitorSessionId?: string;
  shareSlug: string | null;
  locale: string | null;
  ltiCourseGrant?: number;
  ltiVideoGrant?: number[];
  ltiSubjectKey?: string;
  ltiSessionProof?: LtiSessionProof;
  displayQuestion?: string;
};
