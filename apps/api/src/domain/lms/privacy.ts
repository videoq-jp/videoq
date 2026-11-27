export const ORPHAN_CONTEXT = '@orphan';
export const privacyCollections = ['logs', 'evaluations', 'conversations', 'turns', 'questions', 'replies', 'votes', 'moderation',
  'material_operations', 'tag_operations', 'report_accesses', 'recent_history', 'checkpoints', 'checkpoint_blobs', 'checkpoint_writes'] as const;
export type PrivacyInstallation = { id: string; ownerUserId: string; issuer: string; clientId: string; deploymentId: string; jwksUrl?: string };
export type PrivacySubject = { subjectKey: string; subjectHash: string; registrationId: string };
export type PrivacyCursor = { after?: string; record?: { id: string; offset: number; revision: string } };
export type PrivacyRequest =
  | { action: 'catalog'; after?: string }
  | { action: 'contexts'; subject: string; after?: string }
  | { action: 'users'; subjects: string[]; contexts: string[] }
  | { action: 'export'; subject: string; contexts: string[]; collection: typeof privacyCollections[number]; cursor?: PrivacyCursor }
  | { action: 'erase'; subject: string; contexts: string[] };

/** JWT verification and schema validation happen before these claims are trusted. */
export type PrivacyAssertionClaims = {
  iss: string; sub: string; aud: string; deploymentId: string; exp: number; jti: string; request: PrivacyRequest;
};

/** Dependent records contribute no additional contexts beyond their parent. */
export const privacyContextCollections = privacyCollections.filter(name =>
  !(['evaluations', 'turns', 'checkpoints', 'checkpoint_blobs', 'checkpoint_writes'] as readonly string[]).includes(name));
export const PRIVACY_EXPORT_CHUNK_CHARACTERS = 65536;
export const PRIVACY_CONTEXT_PAGE_SIZE = 100;

export function privacyContextPage<T>(rows: readonly T[], context: (row: T) => string) {
  return {
    contexts: rows.slice(0, PRIVACY_CONTEXT_PAGE_SIZE).map(context),
    nextAfter: rows.length > PRIVACY_CONTEXT_PAGE_SIZE ? context(rows[PRIVACY_CONTEXT_PAGE_SIZE - 1]) : null,
  };
}

export type PrivacyExportFragment = {
  id: string; context: string; total: number; revision: string; chunk: string;
};

/** Both backends use character offsets and reject a changed or disappeared record. */
export function privacyExportPage(row: PrivacyExportFragment | null | undefined, point?: PrivacyCursor['record']) {
  if (!row) return point ? { changed: true as const } : { part: null, next: null };
  if (point && (point.revision !== row.revision || point.offset >= row.total)) return { changed: true as const };
  const offset = point?.offset ?? 0;
  const nextOffset = Math.min(row.total, offset + PRIVACY_EXPORT_CHUNK_CHARACTERS);
  return {
    part: { id: row.id, context: row.context, offset, total: row.total, revision: row.revision, chunk: row.chunk },
    next: nextOffset < row.total
      ? { record: { id: row.id, offset: nextOffset, revision: row.revision } }
      : { after: row.id },
  };
}
