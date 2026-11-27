import { z } from 'zod';
import type { CourseSkillPublicationRepository } from '../../persistence/contracts/course-skill-publication-repository';
import { ToolError } from '../../tools/errors';
import { SkillLookupError } from './skills-service';
import { defineTool } from '../../tools/definition';
import type { ToolActorContext } from '../../tools/management';
import { createCourseSkillPublicationRepository } from '../../integrations/course-skill-publications';
import { createMcpSkillsService } from './skills-service';

/** Standard-tool fallback for clients without the MCP Skills extension. */
export function createCourseSkillTools(ctx: ToolActorContext, repository?: CourseSkillPublicationRepository) {
  const service = async () => createMcpSkillsService(repository ?? await createCourseSkillPublicationRepository(ctx.env), ctx.userId);
  const metadata = { access: 'read' as const, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } };
  async function available<T>(read: () => Promise<T>) {
    try { return await read(); }
    catch (error) {
      if (error instanceof SkillLookupError) throw new ToolError('Skill unavailable or not authorized.', { status: 404, code: 'SKILL_UNAVAILABLE' });
      throw error;
    }
  }
  const uri = z.string().min(1).max(2048);
  return [
    defineTool(async ({ cursor }) => (await service()).list(cursor), { ...metadata,
      name: 'list_course_skills', description: 'List published course skill metadata accessible to this user. Follow nextCursor for more results. Course IDs are included in skill URIs; fetch only skills relevant to the requested course and task.',
      schema: z.object({ cursor: z.string().max(1024).optional() }).strict(),
    }),
    defineTool(async ({ uri }) => available(async () => (await service()).get(uri)), { ...metadata,
      name: 'get_course_skill', description: 'Get the current authorized manifest for a published skill URI from list_course_skills. This returns metadata, not the Skill instructions. Before applying the Skill, call read_course_skill_resource for its SKILL.md URI, then read relevant cited references as needed. Checks publication, distribution, course access and live source validity on every call.',
      schema: z.object({ uri }).strict(),
    }),
    defineTool(async ({ uri }) => available(async () => (await service()).read(uri)), { ...metadata,
      name: 'read_course_skill_resource', description: 'Read a SKILL.md or cited reference URI from a current skill manifest. Rechecks access and live source validity. If unavailable, stop using that version; do not fall back to cached instructions.',
      schema: z.object({ uri }).strict(),
    }),
  ];
}
