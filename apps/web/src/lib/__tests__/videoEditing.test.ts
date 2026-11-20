import { describe, expect, it, vi } from 'vitest';
import { saveVideoEdits } from '../../application/video-editing';

function dependencies() {
  return {
    updateMetadata: vi.fn().mockResolvedValue({ title: 'saved' }),
    addTags: vi.fn().mockResolvedValue(undefined),
    removeTag: vi.fn().mockResolvedValue(undefined),
    refresh: vi.fn().mockResolvedValue(undefined),
  };
}

describe('video editing workflow without UI or transport', () => {
  it('does not write or refresh an unchanged video', async () => {
    const deps = dependencies();
    await saveVideoEdits(1, { title: 'original', description: null, tags: [{ id: 2 }] }, {
      title: 'original', description: '', tagIds: [2],
    }, deps);
    expect(deps.updateMetadata).not.toHaveBeenCalled();
    expect(deps.addTags).not.toHaveBeenCalled();
    expect(deps.removeTag).not.toHaveBeenCalled();
    expect(deps.refresh).not.toHaveBeenCalled();
  });

  it('refreshes saved metadata after an uncertain tag write without starting removals', async () => {
    const deps = dependencies();
    const error = new Error('tag write interrupted');
    deps.addTags.mockRejectedValue(error);
    await expect(saveVideoEdits(1, { title: 'original', tags: [{ id: 2 }] }, {
      title: 'saved', description: '', tagIds: [3],
    }, deps)).rejects.toBe(error);
    expect(deps.updateMetadata).toHaveBeenCalledWith({ id: 1, title: 'saved' });
    expect(deps.removeTag).not.toHaveBeenCalled();
    expect(deps.refresh).toHaveBeenCalledWith(1, {
      metadataChanged: true, tagsChanged: true, updatedVideo: { title: 'saved' },
    });
  });

  it('waits for every started removal before refreshing and reporting a failure', async () => {
    const deps = dependencies();
    const error = new Error('one removal failed');
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    deps.removeTag.mockImplementation(({ tagId }: { tagId: number }) =>
      tagId === 2 ? Promise.reject(error) : pending);
    const outcome = saveVideoEdits(1, { title: 'original', tags: [{ id: 2 }, { id: 3 }] }, {
      title: 'original', description: '', tagIds: [],
    }, deps).catch((failure: unknown) => failure);
    await Promise.resolve();
    expect(deps.removeTag).toHaveBeenCalledTimes(2);
    expect(deps.refresh).not.toHaveBeenCalled();
    release();
    expect(await outcome).toBe(error);
    expect(deps.refresh).toHaveBeenCalledWith(1, {
      metadataChanged: false, tagsChanged: true, updatedVideo: undefined,
    });
  });
});
