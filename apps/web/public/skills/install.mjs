#!/usr/bin/env node
// Dependency-free VideoQ skill installer. Node.js 22+.
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile, rename, rm, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export function options(args) {
  const { values } = parseArgs({ args, options: {
    origin: { type: 'string' }, skill: { type: 'string' },
    agent: { type: 'string', default: 'both' }, global: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) return values;
  if (!values.origin || !values.skill) {
    throw new Error('Generate a skill set in VideoQ, then provide --origin and --skill ID.');
  }
  const url = new URL(values.origin);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('--origin must be an HTTPS origin (HTTP is allowed only on localhost).');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(values.skill)) throw new Error('Skill ID must be a UUID.');
  if (!['codex', 'claude', 'both'].includes(values.agent)) throw new Error('--agent must be codex, claude, or both.');
  return { ...values, origin: url.origin, skill: values.skill.toLowerCase() };
}

// Read only the matching JSON-RPC response; SSE connections may stay open.
export async function rpcResponse(response, id) {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`VideoQ HTTP ${response.status}. Check the host, API key, permissions, or rate limit.`);
  }
  let message;
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '', size = 0;
    try {
      while (!message) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2_000_000) throw new Error('MCP response is too large.');
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (!data) continue;
          const candidate = JSON.parse(data);
          if (candidate.id === id) { message = candidate; break; }
        }
      }
    } finally { await reader.cancel(); }
  } else {
    message = await response.json();
  }
  if (!message || message.id !== id) throw new Error('Missing MCP response.');
  if (message.error) throw new Error('VideoQ rejected the request. Check permissions and retry.');
  return message.result;
}

export async function connect(origin, token, fetcher = fetch) {
  let sequence = 0, session, protocol = '2025-03-26';
  const send = async (method, params, notification = false) => {
    const id = ++sequence;
    const response = await fetcher(`${origin}/api/mcp`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': protocol,
        ...(session ? { 'Mcp-Session-Id': session } : {}), },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }),
    });
    session = response.headers.get('mcp-session-id') ?? session;
    if (notification) {
      await response.body?.cancel();
      if (!response.ok) throw new Error(`MCP initialization failed (HTTP ${response.status}).`);
      return;
    }
    return rpcResponse(response, id);
  };
  const initialized = await send('initialize', {
    protocolVersion: protocol, capabilities: {}, clientInfo: { name: 'videoq-skills', version: '1.0.0' },
  });
  protocol = initialized.protocolVersion;
  await send('notifications/initialized', {}, true);
  return {
    async call(name, args) {
      const result = await send('tools/call', { name, arguments: args });
      if (result.isError) {
        const reason = name === 'get_skill' ? result.content?.find(item => item.type === 'text')?.text : null;
        throw new Error(typeof reason === 'string' ? reason.replace(/\p{Cc}/gu, ' ').slice(0, 500) : `Cannot read ${name}. Check ownership, processing status, and rate limits.`);
      }
      const output = result.structuredContent ?? JSON.parse(result.content.find(item => item.type === 'text').text);
      return output.result ?? output;
    },
    async close() {
      if (!session) return;
      const response = await fetcher(`${origin}/api/mcp`, {
        method: 'DELETE', redirect: 'error', signal: AbortSignal.timeout(5_000),
        headers: { Authorization: `Bearer ${token}`, 'Mcp-Session-Id': session, 'MCP-Protocol-Version': protocol },
      });
      await response.body?.cancel();
    },
  };
}

export async function downloadSkill(client, config) {
  const { skill } = await client.call('get_skill', { skill_id: config.skill });
  if (!skill || skill.id !== config.skill) throw new Error('Invalid published skill set.');
  const validate = (artifact) => {
    if (!artifact || artifact.id !== config.skill || typeof artifact.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(artifact.name)) throw new Error('Invalid published skill.');
    const paths = ['SKILL.md', 'references/sources.md'];
    if (!artifact.files || Object.keys(artifact.files).length !== paths.length || paths.some(path => typeof artifact.files[path] !== 'string' || !artifact.files[path].trim() || artifact.files[path].length > 250_000)) throw new Error('Invalid skill files.');
    if (!artifact.files['SKILL.md'].startsWith(`---\nname: ${artifact.name}\n`)) throw new Error('Skill identity does not match its entrypoint.');
    return { name: artifact.name, files: new Map(paths.map(path => [path, artifact.files[path]])) };
  };
  const first = validate(skill);
  if (skill.skills === undefined) return first;
  if (!Array.isArray(skill.skills) || !skill.skills.length || skill.skills.length > 12) throw new Error('Invalid skill set.');
  const skills = skill.skills.map(validate);
  if (new Set(skills.map(item => item.name)).size !== skills.length || skills[0].name !== first.name || [...first.files].some(([path, content]) => skills[0].files.get(path) !== content)) throw new Error('Invalid skill set identities.');
  return { ...first, skills };
}

export async function install(bundle, config, { cwd = process.cwd(), home = homedir() } = {}) {
  const root = config.global ? home : cwd;
  const agents = config.agent === 'both' ? ['codex', 'claude'] : [config.agent];
  const installed = [];
  const stages = [];
  try {
    for (const item of bundle.skills ?? [bundle]) for (const agent of agents) {
      const parent = resolve(root, agent === 'codex' ? '.agents/skills' : '.claude/skills');
      const destination = join(parent, item.name);
      // Never overwrite an existing skill or follow its symlink.
      try { await lstat(destination); throw new Error(`Already installed: ${destination}. Remove it explicitly before reinstalling.`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(parent, { recursive: true });
      const temporary = await mkdtemp(join(parent, '.videoq-install-'));
      stages.push({ temporary, destination });
      for (const [file, content] of item.files) {
        const path = join(temporary, file);
        await mkdir(resolve(path, '..'), { recursive: true });
        await writeFile(path, content, { mode: 0o600, flag: 'wx' });
      }
    }
    for (const { temporary, destination } of stages) {
      // Exclusive mkdir reserves the name even if another installer starts concurrently.
      await mkdir(destination);
      installed.push(destination);
      await rename(join(temporary, 'references'), join(destination, 'references'));
      // Publish the entrypoint last, after every reference is in place.
      await rename(join(temporary, 'SKILL.md'), join(destination, 'SKILL.md'));
    }
    return installed;
  } catch (error) {
    for (const path of installed) await rm(path, { recursive: true, force: true });
    throw error;
  } finally {
    for (const { temporary } of stages) await rm(temporary, { recursive: true, force: true });
  }
}

async function readToken() {
  if (process.env.VIDEOQ_API_KEY) return process.env.VIDEOQ_API_KEY.trim();
  if (!process.stdin.isTTY) throw new Error('Set VIDEOQ_API_KEY to a read-only VideoQ API key.');
  process.stderr.write('VideoQ read-only API key (hidden): ');
  process.stdin.setRawMode(true);
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  return new Promise((accept, reject) => {
    let token = '';
    const done = (error) => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error); else accept(token.trim());
    };
    const onData = (text) => {
      for (const character of text) {
        if (character === '\u0003' || character === '\u0004') return done(new Error('Cancelled.'));
        if (character === '\r' || character === '\n') return done();
        if (character === '\u007f' || character === '\b') token = token.slice(0, -1);
        else if (character >= ' ') token += character;
      }
    };
    process.stdin.on('data', onData);
  });
}

export async function main(args = process.argv.slice(2)) {
  const config = options(args);
  if (config.help) {
    console.log('VideoQ skills (Node.js 22+)\nGenerate a skill set in VideoQ first.\n--origin https://videoq.example --skill UUID\n[--agent codex|claude|both] [--global]\nRun in your project; use --global for all projects. API key: hidden prompt or VIDEOQ_API_KEY.\nDownloads all checked skills in the course set without an LLM call. Existing skills are never overwritten.');
    return;
  }
  const token = await readToken();
  if (!token) throw new Error('API key is required.');
  console.log('Downloading checked VideoQ skills…');
  const client = await connect(config.origin, token);
  try {
    const bundle = await downloadSkill(client, config);
    const paths = await install(bundle, config);
    const names = (bundle.skills ?? [bundle]).map(item => item.name);
    console.log(`Installed published skills (${names.length}):\n${paths.join('\n')}\n\n${names.map(name => `Codex: $${name} | Claude Code: /${name}`).join('\n')}\nOpen a new agent session if the skill is not visible.\nSkill evidence can contain private course content. Review before committing or sharing.`);
  } finally { await client.close().catch(() => {}); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  main().catch(error => { console.error(`VideoQ: ${error.message}`); process.exitCode = 1; });
}
