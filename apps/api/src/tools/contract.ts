import { z } from "zod";

export const MAX_SCENE_SEARCHES = 3;
export const MAX_COURSE_INFO_CALLS = 5;

/** Wire contract shared by MCP servers and consumers; no server or agent runtime. */
export const toolResponseSchema = z.object({ result: z.union([z.string(), z.record(z.string(), z.unknown())]) });

export const evidenceProgressSchema = z.union([
  z.object({ searching: z.string(), searchId: z.number().int().positive() }).strict(),
  z.object({ searchCompleted: z.object({ id: z.number().int().positive(), query: z.string(), count: z.number().int().nonnegative() }).strict() }).strict(),
]);
