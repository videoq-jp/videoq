import type { Bindings } from "../types/bindings";

export const WORKERS_CHAT_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const WORKERS_EMBEDDING_MODEL = "@cf/google/embeddinggemma-2";
export const WORKERS_BINDING_BASE_URL = "https://workers-ai.invalid/v1";

/** Workers AI appends a usage summary outside the OpenAI chunk envelope. */
function openAiStream(response: Response): Response {
  if (!response.body) throw new Error("Missing inference stream");
  let pending = "";
  const encoder = new TextEncoder();
  const stream = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new TransformStream<string, Uint8Array>({
    transform(part, controller) {
      pending = (pending + part).replace(/\r\n/g, "\n");
      if (pending.length > 1024 * 1024) throw new Error("Invalid inference stream");
      let boundary: number;
      while ((boundary = pending.indexOf("\n\n")) >= 0) {
        const event = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        if (data === "[DONE]") { controller.enqueue(encoder.encode("data: [DONE]\n\n")); continue; }
        let value: Record<string, unknown>;
        try {
          const parsed: unknown = JSON.parse(data);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          value = parsed as Record<string, unknown>;
        } catch { throw new Error("Invalid inference stream"); }
        if (!Array.isArray(value.choices)) {
          if (value.response !== "" || !value.usage || value.error) throw new Error("Invalid inference stream");
          value = { choices: [], usage: value.usage };
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`));
      }
    },
    flush() { if (pending.trim()) throw new Error("Incomplete inference stream"); },
  }));
  return new Response(stream, { status: response.status, headers: response.headers });
}

/** SDK transport stays inside the Worker. No API key or public HTTP fallback. */
export function workersAiChatFetch(env: Pick<Bindings, "AI">): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.url !== `${WORKERS_BINDING_BASE_URL}/chat/completions` || request.method !== "POST") {
      throw new Error("Invalid Workers AI binding destination");
    }
    if (!env.AI) throw new Error("Workers AI binding is required");
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Invalid inference request");
    const values = body as Record<string, unknown>;
    if (values.model !== WORKERS_CHAT_MODEL || !Array.isArray(values.messages)) throw new Error("Invalid Workers AI model/messages");
    const { model: _model, reasoning_effort: _effort, ...parameters } = values;
    // Gemma 4 has a thinking toggle, not OpenAI reasoning effort levels.
    parameters.chat_template_kwargs = { enable_thinking: false };
    request.signal.throwIfAborted();
    try {
      // Dynamic name selects the runtime-validated overload for serialized SDK input.
      const model: string = WORKERS_CHAT_MODEL;
      const response: unknown = await env.AI.run(model, parameters, { returnRawResponse: true, signal: request.signal });
      if (!(response instanceof Response)) throw new Error("Expected raw inference response");
      return values.stream && response.ok && response.headers.get("content-type")?.includes("text/event-stream")
        ? openAiStream(response) : response;
    } catch {
      request.signal.throwIfAborted();
      // Never expose provider errors containing prompts, images or credentials.
      return Response.json({ error: { message: "Workers AI inference failed" } }, { status: 502 });
    }
  };
}
