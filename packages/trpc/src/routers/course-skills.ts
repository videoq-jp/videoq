import { protectedProcedure, t } from '../init';
import { courseSkillsInputSchemas as inputs, courseSkillsOutputSchemas as outputs } from '../course-skills';
export const courseSkillsRouter = t.router({
  list: protectedProcedure.input(inputs['courseSkills.list']).output(outputs['courseSkills.list']).query(({ ctx, input }) => ctx.call('courseSkills.list', input)),
  get: protectedProcedure.input(inputs['courseSkills.get']).output(outputs['courseSkills.get']).query(({ ctx, input }) => ctx.call('courseSkills.get', input)),
  configure: protectedProcedure.input(inputs['courseSkills.configure']).output(outputs['courseSkills.configure']).mutation(({ ctx, input }) => ctx.call('courseSkills.configure', input)),
  rebuild: protectedProcedure.input(inputs['courseSkills.rebuild']).output(outputs['courseSkills.rebuild']).mutation(({ ctx, input }) => ctx.call('courseSkills.rebuild', input)),
  update: protectedProcedure.input(inputs['courseSkills.update']).output(outputs['courseSkills.update']).mutation(({ ctx, input }) => ctx.call('courseSkills.update', input)),
  publish: protectedProcedure.input(inputs['courseSkills.publish']).output(outputs['courseSkills.publish']).mutation(({ ctx, input }) => ctx.call('courseSkills.publish', input)),
  reject: protectedProcedure.input(inputs['courseSkills.reject']).output(outputs['courseSkills.reject']).mutation(({ ctx, input }) => ctx.call('courseSkills.reject', input)),
  withdraw: protectedProcedure.input(inputs['courseSkills.withdraw']).output(outputs['courseSkills.withdraw']).mutation(({ ctx, input }) => ctx.call('courseSkills.withdraw', input)),
});
