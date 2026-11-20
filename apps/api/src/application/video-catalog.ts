export type VideoListCriteria = { keyword: string; statusFilter: string; sortKey: string; tagIds: number[] | null };
export type VideoStatusCounts = { total: number; completed: number; pending: number; processing: number; indexing: number; error: number; uploading: number };

export function videoStatusFilters(value: string): string[] {
  return value.split(',').map(status => status.trim()).filter(Boolean);
}

export function videoListOrder(key: string): { field: 'uploadedAt' | 'title'; direction: 'asc' | 'desc' } {
  switch (key) {
    case 'uploaded_at_asc': return { field: 'uploadedAt', direction: 'asc' };
    case 'title_asc': return { field: 'title', direction: 'asc' };
    case 'title_desc': return { field: 'title', direction: 'desc' };
    default: return { field: 'uploadedAt', direction: 'desc' };
  }
}

export function countVideoStatuses(rows: readonly { status: string; count: number }[]): VideoStatusCounts {
  const stats: VideoStatusCounts = { total: 0, completed: 0, pending: 0, processing: 0, indexing: 0, error: 0, uploading: 0 };
  for (const row of rows) {
    stats.total += row.count;
    switch (row.status) {
      case 'completed': case 'pending': case 'processing': case 'indexing': case 'error': case 'uploading':
        stats[row.status] += row.count;
    }
  }
  return stats;
}

export function videoKeywordMatchedBy<Predicate>(title: Predicate, description: Predicate,
  logic: { or(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.or(title, description);
}

/** Compile once while D1 streams bounded pages; preserve Unicode and literal %/_. */
export function videoKeywordMatcher(keyword: string) {
  const needle = keyword.toLowerCase();
  return (row: { title: string; description: string }) => videoKeywordMatchedBy(
    row.title.toLowerCase().includes(needle), row.description.toLowerCase().includes(needle), { or: (left, right) => left || right });
}

export function videoUploadAbandoned<Value, Predicate>(status: Value, olderThanCutoff: Predicate,
  logic: { statusIs(status: Value, expected: 'uploading'): Predicate; and(left: Predicate, right: Predicate): Predicate }): Predicate {
  return logic.and(logic.statusIs(status, 'uploading'), olderThanCutoff);
}
