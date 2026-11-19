import { expect, it, vi } from "vitest";
import { z } from "zod";
import { defineTool } from "../src/tools/definition";
import { createManagementTools, MANAGEMENT_WRITE_TOOLS } from "../src/tools/management";
import { connectTestTools } from "./helpers/mcp-tools";

it("does not offer management tools to the answer agent even when the MCP server advertises them", async () => {
  const executeWrite = vi.fn(async () => ({ course: { id: 1 } }));
  const definitions = [
    defineTool(async () => "evidence", { name: "search_scenes", description: "Search", schema: z.object({}) }),
    defineTool(executeWrite, { name: "create_course", description: "Create", schema: z.object({}), access: "write" }),
    // Descriptive read-only annotations do not grant Q&A access to unknown capabilities.
    defineTool(async () => "private", { name: "list_videos", description: "List", schema: z.object({}), annotations: { readOnlyHint: true } }),
  ];
  const tools = await connectTestTools(definitions);
  expect(tools.map(tool => tool.name)).toEqual(["search_scenes"]);
  expect(await tools[0].invoke({})).toBe("evidence");
  expect(executeWrite).not.toHaveBeenCalled();
});

it("requires write authority when a definition is invoked directly, independently of MCP", async () => {
  const definitions = createManagementTools({ env: {} as never, userId: "reader", canWrite: false });
  const args: Record<string, Record<string, unknown>> = {
    request_video_upload: { filename: "lecture.mp4", content_type: "video/mp4", file_size: 10, title: "Lecture", idempotency_key: "upload-1" },
    confirm_video_upload: { video_id: 1 },
    create_youtube_video: { youtube_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", idempotency_key: "youtube-1", title: "Lecture" },
    create_course: { name: "Course", idempotency_key: "course-1" },
    add_video_to_course: { course_id: 1, video_id: 1 },
  };
  expect(definitions).toHaveLength(12);
  const writes = definitions.filter(tool => tool.access === "write");
  expect(writes).toHaveLength(5);
  for (const definition of writes) {
    expect([...MANAGEMENT_WRITE_TOOLS].some(name => name === definition.name)).toBe(true);
    await expect(definition.invoke(args[definition.name], { signal: new AbortController().signal }))
      .rejects.toMatchObject({ data: { status: 403, code: "FORBIDDEN" } });
  }
});

it("cancels management execution before accessing services", async () => {
  const tool = createManagementTools({ env: {} as never, userId: "writer", canWrite: true }).find(tool => tool.name === "create_course")!;
  const controller = new AbortController();
  controller.abort();
  await expect(tool.invoke({ name: "Course", idempotency_key: "course-1" }, { signal: controller.signal })).rejects.toThrow();
});
