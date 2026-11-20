import { expect, it, vi } from 'vitest';
import { uploadPreparedFile, type FileUploadDependencies } from '../../application/file-upload';

function fixture(multipart?: { partSize: number }) {
  return {
    request: vi.fn(async () => ({ videoId: 7, directUrl: 'https://storage.test/upload', multipart })),
    multipart: vi.fn(async () => 'multipart committed'),
    transfer: vi.fn(async () => {}),
    confirm: vi.fn(async () => 'direct committed'),
  } satisfies FileUploadDependencies<{ partSize: number }, string>;
}
it('confirms the video only after the direct transfer succeeds', async () => {
  const deps = fixture();
  let release!: () => void;
  deps.transfer.mockImplementation(() => new Promise<void>(resolve => { release = resolve; }));
  const upload = uploadPreparedFile(deps);
  await vi.waitFor(() => expect(deps.transfer).toHaveBeenCalledWith('https://storage.test/upload'));
  expect(deps.confirm).not.toHaveBeenCalled();
  release();
  expect(await upload).toBe('direct committed');
  expect(deps.confirm).toHaveBeenCalledWith(7);
});
it('lets multipart completion own confirmation even if a direct URL is also present', async () => {
  const deps = fixture({ partSize: 10 });
  expect(await uploadPreparedFile(deps)).toBe('multipart committed');
  expect(deps.multipart).toHaveBeenCalledWith(7, { partSize: 10 });
  expect(deps.transfer).not.toHaveBeenCalled();
  expect(deps.confirm).not.toHaveBeenCalled();
});
it.each(['request', 'transfer', 'multipart'] as const)('does not confirm when %s fails', async operation => {
  const deps = fixture(operation === 'multipart' ? { partSize: 10 } : undefined);
  const error = new Error(operation);
  deps[operation].mockRejectedValue(error);
  await expect(uploadPreparedFile(deps)).rejects.toBe(error);
  expect(deps.confirm).not.toHaveBeenCalled();
});
it('rejects a missing direct upload URL before transfer', async () => {
  const deps: FileUploadDependencies<never, string> = { ...fixture(), request: async () => ({ videoId: 7 }) };
  await expect(uploadPreparedFile(deps)).rejects.toThrow('Upload URL is missing');
  expect(deps.transfer).not.toHaveBeenCalled();
});
