import { describe, expect, it, vi } from 'vitest';
import { qaInputSchemas } from '../../../packages/trpc/src/qa';
import { createQaService } from '../src/features/qa/core';
import type { QaCommand, QaRepository } from '../src/persistence/contracts/qa-repository';

const questionId = '00000000-0000-4000-8000-000000000001';
const replyId = '00000000-0000-4000-8000-000000000002';
const nul = 'Text' + String.fromCharCode(0) + 'suffix';
const commands: QaCommand[] = [
  { name: 'qa.ask', input: { courseId: 1, videoId: null, title: nul, body: 'Body' } },
  { name: 'qa.ask', input: { courseId: 1, videoId: null, title: 'Title', body: nul } },
  { name: 'qa.updateQuestion', input: { courseId: 1, questionId, title: nul, body: 'Body' } },
  { name: 'qa.updateQuestion', input: { courseId: 1, questionId, title: 'Title', body: nul } },
  { name: 'qa.reply', input: { courseId: 1, questionId, body: nul } },
  { name: 'qa.updateReply', input: { courseId: 1, questionId, replyId, body: nul } },
];

describe('Q&A text input contract', () => {
  it.each(commands)('rejects NUL in the public $name input', command => {
    expect(qaInputSchemas[command.name].safeParse(command.input).success).toBe(false);
  });

  it.each(commands)('rejects direct $name before calling persistence', async command => {
    const repository: QaRepository = {
      list: vi.fn(), get: vi.fn(), mutate: vi.fn().mockResolvedValue({ success: true }),
    };
    await expect(createQaService(repository).mutate('actor', command)).rejects.toMatchObject({ kind: 'validation' });
    expect(repository.mutate).not.toHaveBeenCalled();
  });

  it('preserves public trim, Unicode, newlines and the existing length limits', () => {
    const text = '日本語 😀 e\u0301\n本文';
    expect(qaInputSchemas['qa.ask'].parse({ courseId: 1, title: ` ${text} `, body: ` ${text} ` }))
      .toMatchObject({ title: text, body: text });
    expect(qaInputSchemas['qa.ask'].safeParse({ courseId: 1, title: 'a'.repeat(201), body: 'body' }).success).toBe(false);
    expect(qaInputSchemas['qa.reply'].safeParse({ courseId: 1, questionId, body: 'a'.repeat(10_001) }).success).toBe(false);
  });

  it('forwards valid commands unchanged and preserves repository authorization failures', async () => {
    const failure = new Error('existing authorization failure');
    const repository: QaRepository = { list: vi.fn(), get: vi.fn(), mutate: vi.fn().mockRejectedValue(failure) };
    const command: QaCommand = { name: 'qa.ask', input: { courseId: 1, videoId: null, title: '日本語 😀', body: ' e\u0301\n本文 ' } };
    await expect(createQaService(repository).mutate('actor', command)).rejects.toBe(failure);
    expect(repository.mutate).toHaveBeenCalledExactlyOnceWith('actor', command);
  });
});
