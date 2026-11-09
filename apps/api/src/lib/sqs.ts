import { AwsClient } from "aws4fetch";
import type { Bindings } from "../types/bindings";
import { deadlineSignal } from "./request-timeout";

const SQS_TIMEOUT_MS = 10_000;

function queueForMessage(env: Bindings, messageBody: string): string | undefined {
  const { type } = JSON.parse(messageBody) as { type?: string };
  if (type === "delete_account_data") {
    return env.SQS_ACCOUNT_QUEUE_URL?.trim() || env.SQS_QUEUE_URL?.trim();
  }
  if (["index_video_transcript", "reindex_video_transcript", "reindex_all_videos_embeddings"].includes(type ?? "")) {
    return env.SQS_SEARCH_QUEUE_URL?.trim() || env.SQS_QUEUE_URL?.trim();
  }
  return env.SQS_MEDIA_QUEUE_URL?.trim() || env.SQS_QUEUE_URL?.trim();
}

/**
 * SQS SendMessage（aws4fetch SigV4, query プロトコル）。
 * MessageBody はそのまま送る（方式 B: 外側 base64 不要の plain JSON）。返り値は MessageId。
 * IAM は sqs:SendMessage のみに限定する（JR-5）。
 */
export async function sendSqsMessage(
  env: Bindings,
  messageBody: string,
): Promise<string | null> {
  // Local wrangler often has no SQS. Return null so callers can leave the row
  // pending and a local worker can drain it (see apps/worker README).
  let queueUrl: string | undefined;
  try {
    queueUrl = queueForMessage(env, messageBody);
  } catch {
    return null;
  }
  if (!queueUrl) return null;
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    return null;
  }

  const aws = new AwsClient({
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
    region: env.AWS_REGION ?? "ap-northeast-1",
    service: "sqs",
    // The durable outbox owns retries. aws4fetch's backoff is not abortable and
    // can keep this delivery waiting after its deadline has expired.
    retries: 0,
  });

  const form = new URLSearchParams({
    Action: "SendMessage",
    Version: "2012-11-05",
    MessageBody: messageBody,
  });

  try {
    const res = await aws.fetch(queueUrl, {
      method: "POST",
      body: form.toString(),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      signal: deadlineSignal(SQS_TIMEOUT_MS),
    });

    const text = await res.text();
    if (!res.ok) {
      console.error(
        JSON.stringify({
          level: "error",
          error: "SQS SendMessage failed",
          status: res.status,
          body: text.slice(0, 500),
        }),
      );
      return null;
    }
    return (text.match(/<MessageId>([^<]+)<\/MessageId>/) || [])[1] ?? null;
  } catch (e) {
    console.error(
      JSON.stringify({
        level: "error",
        error: "SQS SendMessage threw",
        message: e instanceof Error ? e.message : String(e),
      }),
    );
    return null;
  }
}
