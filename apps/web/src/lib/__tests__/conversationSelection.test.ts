import { describe, expect, it, vi } from 'vitest';
import { restoreConversationSelection, rememberConversation, forgetConversation } from '@/application/conversation-selection';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';

describe('conversation identity state', () => {
  it('restores only bounded identity metadata and excludes stored messages', () => {
    const newId = vi.fn();
    const restored = restoreConversationSelection({ selected: { id, restore: true, messages: ['private'] },
      knownIds: [false, 'invalid', ...Array.from({ length: 101 }, () => other)], messages: ['private'] }, newId);
    expect(restored).toEqual({ selected: { id, restore: true }, knownIds: Array.from({ length: 100 }, () => other) });
    expect(newId).not.toHaveBeenCalled();
  });

  it('starts a fresh draft for corrupt identity metadata', () => {
    const newId = vi.fn().mockReturnValue(id);
    expect(restoreConversationSelection({ selected: { id: 'invalid', restore: true }, knownIds: [other] }, newId))
      .toEqual({ selected: { id, restore: false }, knownIds: [] });
    expect(newId).toHaveBeenCalledOnce();
  });

  it('persists recovery intent while leaving the mounted draft unchanged', () => {
    const selected = { id, restore: false };
    const knownIds = [other, id, id, ...Array.from({ length: 100 }, () => other)];
    const remembered = rememberConversation(selected.id, knownIds);
    expect(remembered.selected).toEqual({ id, restore: true });
    expect(remembered.knownIds[0]).toBe(id);
    expect(remembered.knownIds.filter(value => value === id)).toHaveLength(1);
    expect(remembered.knownIds).toHaveLength(100);
    expect(selected.restore).toBe(false);
    expect(knownIds).toHaveLength(103);
  });

  it('replaces only the deleted active conversation and preserves other selections', () => {
    const current = { selected: { id, restore: true }, knownIds: [id, other] };
    const newId = vi.fn().mockReturnValue('new-draft');
    expect(forgetConversation(current, other, newId)).toEqual({ selected: current.selected, knownIds: [id] });
    expect(newId).not.toHaveBeenCalled();
    expect(forgetConversation(current, id, newId)).toEqual({ selected: { id: 'new-draft', restore: false }, knownIds: [other] });
    expect(newId).toHaveBeenCalledOnce();
    expect(current.knownIds).toEqual([id, other]);
  });
});
