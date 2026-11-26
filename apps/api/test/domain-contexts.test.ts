import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { decideCourseInvitation, type CourseInvitation } from '../src/domain/learning/invitation-lifecycle';

const root = fileURLToPath(new URL('../src/domain/', import.meta.url));
// Published policies only. New relationships require a context-map decision.
const publishedDependencies: Record<string, readonly string[]> = {
  identity: ['billing/signup-quota'],
  conversation: ['lms/subject-identity'],
  lms: ['billing/quota-policy'],
  qa: ['learning/native-course-access'],
};

it('keeps domain contexts closed except for published upstream policies', () => {
  const contexts = readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory());
  expect(contexts.map(entry => entry.name).sort()).toEqual([
    'billing', 'conversation', 'identity', 'learning', 'lms', 'media', 'operations', 'qa', 'search', 'skills',
  ]);
  for (const context of contexts) {
    for (const entry of readdirSync(resolve(root, context.name))) {
      if (!entry.endsWith('.ts')) continue;
      const path = resolve(root, context.name, entry);
      const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const statement of source.statements) {
        if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier) continue;
        expect(ts.isStringLiteral(statement.moduleSpecifier)).toBe(true);
        const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
        if (specifier.startsWith('@videoq/domain/')) continue;
        expect(specifier.startsWith('.'), path).toBe(true);
        const target = relative(root, resolve(dirname(path), specifier));
        expect(target.startsWith('..'), `${path}: ${specifier}`).toBe(false);
        if (!target.startsWith(context.name + '/')) {
          expect(publishedDependencies[context.name] ?? [], `${path}: unpublished dependency ${target}`).toContain(target);
        }
      }
    }
  }
});

const now = new Date('2026-11-27T00:00:00Z');
const invitation: CourseInvitation = {
  id: 7, courseId: 3, status: 'pending', expiresAt: '2026-11-28T00:00:00Z', acceptedByUserId: null,
};
it('acceptance requires recipient verification and a single invitation/membership commit', () => {
  expect(decideCourseInvitation(invitation, 'accept', 'member', now)).toEqual({
    kind: 'verifyRecipient', effects: { status: 'accepted', addMembership: true, requiresNative: true },
  });
  expect(invitation.status).toBe('pending');
});
it('declining never grants membership and remains possible after native participation is disabled', () => {
  expect(decideCourseInvitation(invitation, 'decline', 'member', now)).toEqual({
    kind: 'verifyRecipient', effects: { status: 'declined', addMembership: false, requiresNative: false },
  });
});
it('retries by the accepting member succeed after expiry without granting a different actor access', () => {
  const accepted = { ...invitation, status: 'accepted' as const, acceptedByUserId: 'member', expiresAt: now.toISOString() };
  expect(decideCourseInvitation(accepted, 'accept', 'member', now)).toEqual({ kind: 'replay', courseId: 3 });
  expect(decideCourseInvitation(accepted, 'accept', 'other', now)).toEqual({ kind: 'invalidState', status: 'accepted' });
  expect(decideCourseInvitation(accepted, 'decline', 'member', now)).toEqual({ kind: 'invalidState', status: 'accepted' });
});
it.each(['accepted', 'declined', 'revoked', 'expired'] as const)('does not reopen a %s invitation', status => {
  expect(decideCourseInvitation({ ...invitation, status }, 'accept', 'other', now)).toEqual({ kind: 'invalidState', status });
});
it('expiry includes equality and applies before recipient verification', () => {
  expect(decideCourseInvitation({ ...invitation, expiresAt: now.toISOString() }, 'accept', 'member', now)).toEqual({ kind: 'expired' });
});
