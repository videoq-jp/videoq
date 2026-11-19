import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Bindings } from "../types/bindings";
import { createEvidenceSession, type EvidenceToolScope } from "../tools/session";
import { registerEvidenceTools } from "../tools/mcp";
import type { UsageRecorder } from "../tools/usage";

/** Local transport bootstrap. Consumers can replace it with an HTTP MCP client. */
export async function connectEvidenceMcp(
  env: Bindings, scope: EvidenceToolScope, signal: AbortSignal,
  options: { question?: string; usage?: UsageRecorder } = {},
) {
  const lifecycle = new AbortController();
  const sessionSignal = AbortSignal.any([signal, lifecycle.signal]);
  const session = createEvidenceSession(env, scope, sessionSignal, options);
  const server = new McpServer({ name: "videoq-evidence", version: "1.0.0" });
  registerEvidenceTools(server, session.tools, sessionSignal);
  const client = new Client({ name: "videoq-agent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const close = async () => {
    lifecycle.abort();
    await Promise.allSettled([client.close(), server.close()]);
    await session.close();
  };
  try {
    sessionSignal.throwIfAborted();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return { client, close };
  } catch (error) {
    await close();
    throw error;
  }
}
