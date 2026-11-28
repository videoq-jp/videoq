import { expect, it } from 'vitest';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readBoundedRegularFile } from '../scripts/course-skill-evaluation/bounded-file';

it('reads bounded artifacts and rejects oversized files, symlinks and directories', async () => {
  const root = await mkdtemp(join(tmpdir(), 'videoq-bounded-file-'));
  try {
    const path = join(root, 'artifact'), link = join(root, 'link');
    await writeFile(path, 'exact');
    expect((await readBoundedRegularFile(path, 5)).toString()).toBe('exact');
    await expect(readBoundedRegularFile(path, 4)).rejects.toThrow('EVALUATION_ARTIFACT_TOO_LARGE');
    await symlink(path, link);
    await expect(readBoundedRegularFile(link, 5)).rejects.toThrow();
    await expect(readBoundedRegularFile(root, 5)).rejects.toThrow('EVALUATION_ARTIFACT_NOT_REGULAR');
  } finally { await rm(root, { recursive: true, force: true }); }
});
