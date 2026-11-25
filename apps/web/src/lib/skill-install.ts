export type Agent = 'codex' | 'claude' | 'both';
const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export function skillInstallCommand(origin: string, skillId: string, agent: Agent, global: boolean) {
  const url = `${origin}/api/skills/${skillId}.tgz`;
  const target = /^[a-zA-Z0-9:/._%-]+$/.test(url) ? url : shellQuote(url);
  return `npx --yes ${target}${agent === 'both' ? '' : ` --agent ${agent}`}${global ? ' --global' : ''}`;
}
