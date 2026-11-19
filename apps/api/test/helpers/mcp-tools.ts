import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach } from "vitest";
import { registerTools } from "../../src/tools/mcp";
import type { ToolDefinition } from "../../src/tools/definition";
import { loadRagMcpTools } from "../../src/lib/rag-mcp-tools";
import type { SceneHit } from "../../src/repositories/vector-repository";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

/** Exercise the real MCP transport and the production consumer adapter. */
export async function connectTestTools(
  definitions: readonly ToolDefinition[], signal = new AbortController().signal,
  options = { addSource: (_hit: SceneHit) => 1, collectContext: (_text: string) => {} },
) {
  const server = new McpServer({ name: "test-tools", version: "1" });
  const client = new Client({ name: "test-consumer", version: "1" });
  registerTools(server, definitions, signal);
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  cleanups.push(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return loadRagMcpTools(client, signal, options);
}
