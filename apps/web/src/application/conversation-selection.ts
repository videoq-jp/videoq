const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type ConversationSelection = { id: string; restore: boolean };
export type StoredConversations = { selected: ConversationSelection; knownIds: string[] };

/** Restore identity metadata only; stored message bodies never enter chat state. */
export function restoreConversationSelection(data: unknown, newId: () => string): StoredConversations {
  if (data && typeof data === 'object' && 'selected' in data && 'knownIds' in data
    && Array.isArray(data.knownIds) && data.selected && typeof data.selected === 'object'
    && 'id' in data.selected && typeof data.selected.id === 'string' && UUID.test(data.selected.id)
    && 'restore' in data.selected && typeof data.selected.restore === 'boolean') {
    return { selected: { id: data.selected.id, restore: data.selected.restore },
      knownIds: data.knownIds.filter((id): id is string => typeof id === 'string' && UUID.test(id)).slice(0, 100) };
  }
  return { selected: { id: newId(), restore: false }, knownIds: [] };
}

/** Persist recovery intent before streaming without replacing the live draft. */
export function rememberConversation(id: string, knownIds: readonly string[]): StoredConversations {
  return { selected: { id, restore: true }, knownIds: [id, ...knownIds.filter(value => value !== id)].slice(0, 100) };
}

export function forgetConversation(
  current: StoredConversations, id: string, newId: () => string,
): StoredConversations {
  return { knownIds: current.knownIds.filter(value => value !== id),
    selected: current.selected.id === id ? { id: newId(), restore: false } : current.selected };
}
