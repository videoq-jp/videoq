import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { withDb } from '../../db/pool';
import { teachingConnections, videoCourses } from '../../db/schema';
import { requireAuth, sessionMethod } from '../../middleware/auth';
import { ApiError, toErrorBody } from '../../shared/errors';
import type { AppEnv } from '../../types/bindings';
import { connectTeachingCourse, readTeachingTicket } from './service';
const opaque = z.string().regex(/^[a-f0-9]{64}$/);
export const teachingRoutes = new Hono<AppEnv>();
teachingRoutes.use('*', bodyLimit({ maxSize: 8192 }));
teachingRoutes.use('*', requireAuth(sessionMethod));
teachingRoutes.use('*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  if (c.req.method !== 'GET') {
    const allowed = [c.env.FRONTEND_URL, ...(c.env.CORS_ALLOW_ORIGIN ?? '').split(',')].filter(Boolean).map(value => new URL(value).origin);
    if (!c.req.header('Origin') || !allowed.includes(c.req.header('Origin')!)) return c.json(toErrorBody('FORBIDDEN', 'Invalid origin.'), 403);
  }
  await next();
});
teachingRoutes.onError((error, c) => error instanceof z.ZodError ? c.json(toErrorBody('VALIDATION_ERROR', 'Invalid connection request.'), 400) : error instanceof ApiError ? c.json(toErrorBody(error.code, error.message), error.status)
  : c.json(toErrorBody('INTERNAL_ERROR', 'The teaching connection is unavailable.'), 500));
teachingRoutes.post('/review', async c => {
  const input = z.object({ ticket: opaque }).strict().parse(await c.req.json());
  const ticket = await readTeachingTicket(c.env, input.ticket);
  const courses = await withDb(c.env, db => db.select({ id: videoCourses.id, name: videoCourses.name })
    .from(videoCourses).where(and(eq(videoCourses.userId, c.var.userId!), eq(videoCourses.nativeAccessDisabled, false))));
  return c.json({ provider: ticket.provider, title: ticket.title, teacherName: ticket.teacherName, contextId: ticket.contextId, courses });
});
teachingRoutes.post('/connect', async c => {
  const input = z.object({ ticket: opaque, courseId: z.number().int().positive().safe().optional() }).strict().parse(await c.req.json());
  return c.json(await connectTeachingCourse(c.env, input.ticket, c.var.userId!, input.courseId));
});
teachingRoutes.get('/connections', async c => c.json({ connections: await withDb(c.env, db => db.select({ id: teachingConnections.id,
  provider: teachingConnections.provider, contextId: teachingConnections.contextId, courseId: teachingConnections.courseId,
  name: videoCourses.name, active: teachingConnections.active }).from(teachingConnections)
  .innerJoin(videoCourses, eq(videoCourses.id, teachingConnections.courseId)).where(eq(teachingConnections.ownerUserId, c.var.userId!))) }));
teachingRoutes.post('/connections/:id/disconnect', async c => {
  if (!z.uuid().safeParse(c.req.param('id')).success) return c.json(toErrorBody('VALIDATION_ERROR', 'Invalid connection.'), 400);
  // Keep the context claimed by its owner so another co-teacher cannot take it over.
  const rows = await withDb(c.env, db => db.update(teachingConnections).set({ active: false }).where(and(
    eq(teachingConnections.id, c.req.param('id')), eq(teachingConnections.ownerUserId, c.var.userId!))).returning({ id: teachingConnections.id }));
  return rows.length ? c.json({ disconnected: true }) : c.json(toErrorBody('NOT_FOUND', 'Connection not found.'), 404);
});
