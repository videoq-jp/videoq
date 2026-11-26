import { qaRouter } from './routers/qa';
import { t } from "./init";
import { accountRouter } from "./routers/account";
import { adminRouter } from "./routers/admin";
import { billingRouter } from "./routers/billing";
import { chatRouter } from "./routers/chat";
import {
  courseMembershipsRouter,
  coursesRouter,
  membershipsRouter,
} from "./routers/courses";
import { tagsRouter } from "./routers/tags";
import { videosRouter } from "./routers/videos";

export const appRouter = t.router({
  qa: qaRouter,
  account: accountRouter,
  admin: adminRouter,
  billing: billingRouter,
  chat: chatRouter,
  courses: coursesRouter,
  courseMemberships: courseMembershipsRouter,
  memberships: membershipsRouter,
  tags: tagsRouter,
  videos: videosRouter,
});

export type AppRouter = typeof appRouter;
