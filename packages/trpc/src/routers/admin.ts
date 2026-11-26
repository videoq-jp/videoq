import { adminProcedure, t } from "../init";
import { adminInputSchemas } from "../inputs/admin";
import { outputSchemas } from "../outputs";

export const adminRouter = t.router({
  inspectSearchRecovery: adminProcedure.input(adminInputSchemas['admin.inspectSearchRecovery']).output(outputSchemas['admin.inspectSearchRecovery']).query(({ctx,input})=>ctx.call('admin.inspectSearchRecovery',input)),
  restartSearchWorkflow: adminProcedure.input(adminInputSchemas['admin.restartSearchWorkflow']).output(outputSchemas['admin.restartSearchWorkflow']).mutation(({ctx,input})=>ctx.call('admin.restartSearchWorkflow',input)),
  createUser: adminProcedure.input(adminInputSchemas["admin.createUser"]).output(outputSchemas["admin.createUser"])
    .mutation(({ ctx, input }) => ctx.call("admin.createUser", input)),
  resetAccess: adminProcedure.input(adminInputSchemas["admin.resetAccess"]).output(outputSchemas["admin.resetAccess"])
    .mutation(({ ctx, input }) => ctx.call("admin.resetAccess", input)),
  listUsers: adminProcedure
    .input(adminInputSchemas["admin.listUsers"])
    .output(outputSchemas["admin.listUsers"])
    .query(({ ctx, input }) => ctx.call("admin.listUsers", input)),
  getUser: adminProcedure
    .input(adminInputSchemas["admin.getUser"])
    .output(outputSchemas["admin.getUser"])
    .query(({ ctx, input }) => ctx.call("admin.getUser", input)),
  patchQuota: adminProcedure
    .input(adminInputSchemas["admin.patchQuota"])
    .output(outputSchemas["admin.patchQuota"])
    .mutation(({ ctx, input }) => ctx.call("admin.patchQuota", input)),
  patchUsage: adminProcedure
    .input(adminInputSchemas["admin.patchUsage"])
    .output(outputSchemas["admin.patchUsage"])
    .mutation(({ ctx, input }) => ctx.call("admin.patchUsage", input)),
  patchFlags: adminProcedure
    .input(adminInputSchemas["admin.patchFlags"])
    .output(outputSchemas["admin.patchFlags"])
    .mutation(({ ctx, input }) => ctx.call("admin.patchFlags", input)),
  deleteUser: adminProcedure
    .input(adminInputSchemas["admin.deleteUser"])
    .output(outputSchemas["admin.deleteUser"])
    .mutation(({ ctx, input }) => ctx.call("admin.deleteUser", input)),
  reindexAll: adminProcedure
    .output(outputSchemas["admin.reindexAll"])
    .mutation(({ ctx }) => ctx.call("admin.reindexAll", undefined)),
});
