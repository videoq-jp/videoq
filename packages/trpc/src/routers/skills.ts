import { protectedProcedure, t } from '../init';
import { skillInputSchemas, skillOutputSchemas } from '../skills';
export const skillsRouter = t.router({
  start: protectedProcedure.input(skillInputSchemas['skills.start']).output(skillOutputSchemas['skills.start']).mutation(({ ctx, input }) => ctx.call('skills.start', input)),
  advance: protectedProcedure.input(skillInputSchemas['skills.advance']).output(skillOutputSchemas['skills.advance']).mutation(({ ctx, input }) => ctx.call('skills.advance', input)),
  get: protectedProcedure.input(skillInputSchemas['skills.get']).output(skillOutputSchemas['skills.get']).query(({ ctx, input }) => ctx.call('skills.get', input)),
  publish: protectedProcedure.input(skillInputSchemas['skills.publish']).output(skillOutputSchemas['skills.publish']).mutation(({ ctx, input }) => ctx.call('skills.publish', input)),
});
