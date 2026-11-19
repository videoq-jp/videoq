import { afterEach, expect, it, vi } from "vitest";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { connectEvidenceMcp } from "../src/integrations/evidence-mcp";
import type { Bindings } from "../src/types/bindings";

afterEach(() => vi.restoreAllMocks());

it("discovers and calls internal MCP tools when runtime code generation is forbidden", async () => {
  const connection = await connectEvidenceMcp({ VIDEO_VISUAL_ENABLED: "false" } as Bindings,
    { ownerUserId: "owner", videoIds: [] }, new AbortController().signal);
  try {
    // Vitest's workerd harness allows eval for its module runner; production does not.
    vi.spyOn(AjvJsonSchemaValidator.prototype, "getValidator").mockImplementation(() => { throw new EvalError("Code generation is disallowed for this context"); });
    const { tools } = await connection.client.listTools();
    expect(tools.map(tool => tool.name)).toContain("search_scenes");
    const result = await connection.client.callTool({ name: "search_scenes", arguments: { query: "topic", video_ids: null } });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("No subtitle scenes matched");
  } finally { await connection.close(); }
});
