/** Executes the actual client, with process-local configuration and isolated skill discovery. */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { chmod, readFile, writeFile, realpath, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

type Skill = { name: string; path: string; enabled: boolean };
type SkillInventory = { data: { skills: Skill[]; errors: unknown[] }[] };
const common = [
  'features.apps=false', 'features.plugins=false', 'features.memories=false', 'features.multi_agent_v2=false',
  'features.browser_use=false', 'features.browser_use_external=false', 'features.computer_use=false',
  'features.skip_host_skill_discovery=false',
  'approval_policy="never"',
  'skills.bundled.enabled=false', 'web_search="disabled"', 'sandbox_workspace_write.network_access=false',
];
const overrides = (values: string[]) => values.flatMap(value => ['-c', value]);
function clientEnvironment(bearer?: string) {
  const allowed = ['HOME', 'USER', 'LOGNAME', 'PATH', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
  const env = Object.fromEntries(allowed.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  if (bearer) env.VIDEOQ_EVALUATION_TOKEN = bearer;
  return env as unknown as NodeJS.ProcessEnv;
}
export async function codexVersion() {
  return (await promisify(execFile)('codex', ['--version'], { env: clientEnvironment(), timeout: 15_000, maxBuffer: 64_000 })).stdout.trim();
}

async function skillInventory(cwd: string, config: string[]) {
  const child = spawn('codex', ['app-server', '--stdio', ...overrides([...common, ...config])], { cwd, env: clientEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  child.stdin.on('error', () => { /* The process exit/error handler rejects pending requests. */ });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let next = 0;
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  const rpc = (method: string, params: unknown) => new Promise<unknown>((resolve, reject) => {
    const id = next++; pending.set(id, { resolve, reject }); send({ id, method, params });
  });
  lines.on('line', line => {
    try {
      const value = JSON.parse(line) as { id: number; result?: unknown; error?: unknown };
      const request = pending.get(value.id);
      if (!request) return;
      pending.delete(value.id);
      if (value.error) request.reject(new Error('CODEX_PREFLIGHT_RPC_FAILED')); else request.resolve(value.result);
    } catch { /* Ignore notifications and non-JSON diagnostic lines. */ }
  });
  child.once('exit', () => { for (const request of pending.values()) request.reject(new Error('CODEX_PREFLIGHT_EXITED')); });
  child.once('error', () => { for (const request of pending.values()) request.reject(new Error('CODEX_PREFLIGHT_SPAWN_FAILED')); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 15_000);
  try {
    await rpc('initialize', { clientInfo: { name: 'videoq_eval_isolation', title: 'VideoQ evaluation', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
    const result = await rpc('skills/list', { cwds: [cwd], forceReload: true }) as SkillInventory;
    if (result.data.some(d => d.errors.length)) throw new Error('CODEX_SKILL_DISCOVERY_FAILED');
    return result.data.flatMap(d => d.skills);
  } finally { clearTimeout(timer); child.stdin.end(); lines.close(); child.kill('SIGTERM'); }
}

export async function isolateCodexSkills(cwd: string, bootstrapPath?: string) {
  const directory = await realpath(cwd), allowedPath = bootstrapPath ? await realpath(bootstrapPath) : undefined;
  const discovered = await skillInventory(directory, []);
  const names = [...new Set(discovered.map(s => s.name))];
  const entries = names.map(name => `{name=${JSON.stringify(name)},enabled=false}`);
  if (allowedPath) entries.push(`{path=${JSON.stringify(allowedPath)},enabled=true}`);
  const config = [`skills.config=[${entries.join(',')}]`];
  const resolved = await skillInventory(directory, config), enabled = resolved.filter(s => s.enabled);
  if (allowedPath ? enabled.length !== 1 || enabled[0].path !== allowedPath : enabled.length !== 0) throw new Error('CODEX_SKILL_ISOLATION_FAILED');
  return { config, discoveredCount: discovered.length, enabled: enabled.map(s => ({ name: s.name, path: s.path })) };
}

export async function runCodexTrial(options: {
  workspace: string; prompt: string; model: string; timeoutMs: number;
  bootstrapPath?: string; server?: { url: string; bearer: string; allowedTools: string[] };
}) {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 300_000) throw new Error('INVALID_TRIAL_TIME_BUDGET');
  const isolation = await isolateCodexSkills(options.workspace, options.bootstrapPath);
  const config = [...common, ...isolation.config, 'model_reasoning_effort="medium"', 'model_context_window=32768', 'model_auto_compact_token_limit=24000'];
  if (options.server) config.push(`mcp_servers.videoq.url=${JSON.stringify(options.server.url)}`, 'mcp_servers.videoq.bearer_token_env_var="VIDEOQ_EVALUATION_TOKEN"',
    'mcp_servers.videoq.required=true', `mcp_servers.videoq.enabled_tools=[${options.server.allowedTools.map(name => JSON.stringify(name)).join(',')}]`,
    'mcp_servers.videoq.startup_timeout_sec=30', 'mcp_servers.videoq.tool_timeout_sec=90');
  const artifacts = await mkdtemp(join(tmpdir(), 'videoq-codex-artifacts-'));
  const logPath = join(artifacts, 'execution.jsonl'), messagePath = join(artifacts, 'answer.txt');
  await writeFile(logPath, '', { mode: 0o600 }); await writeFile(messagePath, '', { mode: 0o600 });
  const started = Date.now();
  const execution = await new Promise<{ exitCode: number | null; timedOut: boolean; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn('codex', ['exec', '--strict-config', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '-C', options.workspace, '-s', 'workspace-write', '-m', options.model, '--json', '--color', 'never', '-o', messagePath, ...overrides(config), options.prompt], {
      cwd: options.workspace, env: clientEnvironment(options.server?.bearer), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    let stdout = '', stderr = '', timedOut = false;
    let forced: ReturnType<typeof setTimeout> | undefined;
    const terminate = () => {
      if (!child.pid || forced) return;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { return; }
      forced = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* Already exited. */ } }, 5_000);
    };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, options.timeoutMs);
    child.stdout.on('data', (data: Buffer) => {
      if (stdout.length >= 8_000_000) return;
      stdout += data.toString();
      if (stdout.length >= 8_000_000) { stdout = stdout.slice(0, 8_000_000); timedOut = true; terminate(); }
    });
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-100_000); });
    child.once('error', error => { clearTimeout(timer); clearTimeout(forced); reject(error); });
    child.once('exit', code => {
      clearTimeout(timer); clearTimeout(forced);
      if (timedOut && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* The owned process group already exited. */ } }
      resolve({ exitCode: code, timedOut, stdout, stderr });
    });
  });
  const redact = (text: string) => options.server ? text.replaceAll(options.server.bearer, '[local-evaluation-token]') : text;
  await writeFile(logPath, redact(execution.stdout), { mode: 0o600 });
  await writeFile(join(artifacts, 'execution.stderr.txt'), redact(execution.stderr), { mode: 0o600 });
  await chmod(messagePath, 0o600);
  const events = redact(execution.stdout).split('\n').flatMap(line => { try { return [JSON.parse(line) as { type: string; usage?: unknown }]; } catch { return []; } });
  return { exitCode: execution.exitCode, timedOut: execution.timedOut, elapsedMs: Date.now() - started, isolation,
    completed: execution.exitCode === 0 && events.some(e => e.type === 'turn.completed'),
    usage: events.filter(e => e.type === 'turn.completed').map(e => e.usage),
    answer: redact(await readFile(messagePath, 'utf8')), events, logPath };
}
