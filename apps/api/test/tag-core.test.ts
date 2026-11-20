import { describe, expect, it, vi } from 'vitest';
import { createTagService } from '../src/features/tags/core';
import { TagNameConflictError, type TagRepository } from '../src/persistence/contracts/tag-repository';

function fixture() {
  const repository = {
    listPage: vi.fn(), getDetail: vi.fn(), delete: vi.fn(),
    create: vi.fn(), update: vi.fn(),
  } satisfies TagRepository;
  return { repository, service: createTagService(repository) };
}

describe('tag application service', () => {
  it('rejects invalid creation without persistence and normalizes valid names', async () => {
    const { repository, service } = fixture();
    await expect(service.createUserTag('owner', ' ', 'blue')).resolves.toHaveProperty('error');
    await expect(service.createUserTag('owner', 'Name', 'invalid')).resolves.toHaveProperty('error');
    expect(repository.create).not.toHaveBeenCalled();
    repository.create.mockResolvedValue({ id: 1, name: 'Name', color: 'blue', created_at: '', video_count: 0 });
    await expect(service.createUserTag('owner', ' Name ', 'blue')).resolves.toMatchObject({ tag: { name: 'Name' } });
    expect(repository.create).toHaveBeenCalledWith('owner', 'Name', 'blue');
  });

  it('describes name conflicts without HTTP and preserves unrelated failures', async () => {
    const { repository, service } = fixture();
    repository.update.mockRejectedValue(new TagNameConflictError());
    await expect(service.updateUserTag(1, 'owner', { name: 'Taken' })).rejects.toMatchObject({ kind: 'conflict', code: 'CONFLICT' });
    const failure = new Error('storage unavailable');
    repository.create.mockRejectedValue(failure);
    await expect(service.createUserTag('owner', 'Name', 'blue')).rejects.toBe(failure);
  });
});

it('invalid updates read ownership without writing any part of the patch', async () => {
  const { repository, service } = fixture();
  repository.update.mockResolvedValue({ notFound: true });
  await expect(service.updateUserTag(1, 'outsider', { name: 'New', color: 'bad' })).resolves.toEqual({ notFound: true });
  expect(repository.update).toHaveBeenLastCalledWith(1, 'outsider', {});
  repository.update.mockResolvedValue({ tag: { id: 1, name: 'Old', color: 'blue', created_at: '', video_count: 0 } });
  await expect(service.updateUserTag(1, 'owner', { name: 'New', color: 'bad' })).resolves.toHaveProperty('error');
  expect(repository.update).toHaveBeenLastCalledWith(1, 'owner', {});
  await service.updateUserTag(1, 'owner', { name: ' Renamed ' });
  expect(repository.update).toHaveBeenLastCalledWith(1, 'owner', { name: 'Renamed', color: undefined });
});
