import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { InstallSkillButton } from '../InstallSkillDialog';
import { publishedSkillSet, skillFixtureId } from '../../../../.storybook/fixtures/agentSkill';

beforeEach(() => {
  localStorage.removeItem('videoq:skill-job:course:42');
  localStorage.removeItem('videoq:skill-job:video:7');
});
function handlers(failStep = false) {
  const start = vi.fn().mockResolvedValue({ ...publishedSkillSet, stage: 'extracting', completedChunks: 0, markdown: null, sourcesMarkdown: null, draft: null });
  const advance = vi.fn().mockResolvedValue(publishedSkillSet);
  if (failStep) advance.mockRejectedValueOnce(new Error('Provider interrupted'));
  const publish = vi.fn().mockResolvedValue({ ...publishedSkillSet, stage: 'published' });
  globalThis.__setTrpcHandler('skills.start', start); globalThis.__setTrpcHandler('skills.advance', advance);
  globalThis.__setTrpcHandler('skills.get', () => ({ ...publishedSkillSet, stage: 'extracting' }));
  globalThis.__setTrpcHandler('skills.publish', publish);
  return { start, advance, publish };
}
async function generate() {
  fireEvent.click(screen.getByRole('button', { name: 'skills.open' }));
  expect(screen.queryByLabelText('skills.command')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'skills.generate' }));
  await screen.findByLabelText('skills.command');
}

it('automatically generates multiple skills without purpose input or confirmation and exposes one installation command', async () => {
  const { start, publish } = handlers(); const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  render(<InstallSkillButton kind="course" resourceId={42} />); await generate();
  expect(start).toHaveBeenCalledWith(expect.objectContaining({ kind: 'course', resourceId: 42 }));
  expect(start.mock.calls[0][0]).not.toHaveProperty('objective');
  expect(screen.getByText('APIクライアントの再試行')).toBeInTheDocument();
  expect(screen.getByText('SQLの実行計画を診断する')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'skills.publish' })).not.toBeInTheDocument();
  expect(publish).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('skills.agent'), { target: { value: 'claude' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'skills.global' }));
  fireEvent.click(screen.getByRole('button', { name: 'skills.copy' })); await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
  const command = writeText.mock.calls[0][0] as string;
  expect(command).toBe(`npx --yes ${window.location.origin}/api/skills/${skillFixtureId}.tgz --agent claude --global`);
  expect(command).not.toMatch(/mktemp|curl|\$\(|;|&&/); expect(command).not.toMatch(/Bearer|vq_|API_KEY=/);
});

it('keeps saved progress after failure and resumes before allowing publication', async () => {
  const { advance } = handlers(true);
  render(<InstallSkillButton kind="course" resourceId={42} />);
  fireEvent.click(screen.getByRole('button', { name: 'skills.open' }));
  fireEvent.click(screen.getByRole('button', { name: 'skills.generate' }));
  await screen.findByRole('button', { name: 'skills.resume' });
  expect(localStorage.getItem('videoq:skill-job:course:42')).toBe(skillFixtureId);
  expect(screen.queryByLabelText('skills.command')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'skills.resume' }));
  await screen.findByLabelText('skills.command'); expect(advance).toHaveBeenCalledTimes(2);
});

it('keeps a selectable command when clipboard permission is unavailable', async () => {
  handlers();
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error('Denied')) } });
  render(<InstallSkillButton kind="video" resourceId={7} />); await generate();
  await screen.findByLabelText('skills.command');
  fireEvent.click(screen.getByRole('button', { name: 'skills.copy' }));
  await waitFor(() => expect(screen.getByText('skills.copyError')).toBeInTheDocument());
  expect(screen.getByLabelText<HTMLTextAreaElement>('skills.command').value).toContain(`/api/skills/${skillFixtureId}.tgz`);
});
