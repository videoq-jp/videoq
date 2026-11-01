import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendSqsMessage } from "../src/lib/sqs";
import type { Bindings } from "../src/types/bindings";

const env = {
  SQS_QUEUE_URL: "https://sqs.ap-northeast-1.amazonaws.com/123456789012/videoq-test",
  AWS_ACCESS_KEY_ID: "test-access-key",
  AWS_SECRET_ACCESS_KEY: "test-secret-key",
  AWS_SESSION_TOKEN: "test-session-token",
  AWS_REGION: "ap-northeast-1",
} as Bindings;
const message = JSON.stringify({ type: "index_video_transcript", job_id: "job-1", payload: { video_id: 42 } });
const success = () => new Response("<SendMessageResponse><SendMessageResult><MessageId>message-1</MessageId></SendMessageResult></SendMessageResponse>");
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("SQS delivery with the real AWS signer", () => {
  it("signs one request and preserves the job body and temporary credentials", async () => {
    fetchMock.mockResolvedValueOnce(success());

    await expect(sendSqsMessage(env, message)).resolves.toBe("message-1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][0] as Request;
    expect(request.url).toBe(env.SQS_QUEUE_URL);
    expect(request.method).toBe("POST");
    expect(request.headers.get("authorization")).toContain("/ap-northeast-1/sqs/aws4_request");
    expect(request.headers.get("x-amz-security-token")).toBe("test-session-token");
    expect(new URLSearchParams(await request.text())).toEqual(new URLSearchParams({
      Action: "SendMessage", Version: "2012-11-05", MessageBody: message,
    }));
  });

  it.each([429, 500, 503])("returns HTTP %i to the durable retry path without an in-process retry", async (status) => {
    const response = new Response("<Error>Try later</Error>", { status });
    fetchMock.mockResolvedValueOnce(response).mockImplementation(async () => success());

    await expect(sendSqsMessage(env, message)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.bodyUsed).toBe(true);
  });

  it.each(["SQS_QUEUE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"] as const)("leaves delivery pending when %s is missing", async (key) => {
    await expect(sendSqsMessage({ ...env, [key]: "" }, message)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("leaves delivery pending after a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Network unavailable"));
    await expect(sendSqsMessage(env, message)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a successful response without a message ID", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<SendMessageResponse/>"));
    await expect(sendSqsMessage(env, message)).resolves.toBeNull();
  });

  it("cancels a stalled request at the delivery deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    fetchMock.mockImplementation((input) => new Promise((_, reject) => {
      const request = input as Request;
      request.signal.addEventListener("abort", () => reject(request.signal.reason instanceof Error ? request.signal.reason : new Error("Aborted")), { once: true });
      requestStarted();
    }));

    const delivery = sendSqsMessage(env, message);
    await started;
    expect(timeout).toHaveBeenCalledExactlyOnceWith(10_000);
    deadline.abort(new DOMException("Delivery timed out", "TimeoutError"));
    await expect(delivery).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves delivery pending when reading the response body fails", async () => {
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
      start(controller) { controller.error(new Error("Response interrupted")); },
    })));
    await expect(sendSqsMessage(env, message)).resolves.toBeNull();
  });
});
