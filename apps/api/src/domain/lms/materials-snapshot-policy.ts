export const MAX_MATERIAL_VIDEOS = 1000;
export const MAX_MATERIAL_COURSE_ENTRIES = 1;

/** A snapshot represents one course; absent resources are never implicit tombstones. */
export function materialsSnapshotIssues(snapshot: {
  contextId: string;
  resources: ReadonlyArray<{ externalId: string; manifest: { contextId: string; kind?: 'course' | 'youtube' } }>;
}): string[] {
  const issues: string[] = [], ids = new Set<string>();
  let entries = 0, videos = 0;
  for (const resource of snapshot.resources) {
    if (resource.manifest.kind === 'course') entries++; else videos++;
    if (resource.manifest.contextId !== snapshot.contextId || ids.has(resource.externalId)) {
      issues.push('Duplicate or cross-context material');
    }
    ids.add(resource.externalId);
  }
  if (entries > MAX_MATERIAL_COURSE_ENTRIES || videos > MAX_MATERIAL_VIDEOS) {
    issues.push('Too many course entries or materials');
  }
  return issues;
}
