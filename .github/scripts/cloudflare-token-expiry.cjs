const DAY = 86_400_000;

function dateMillis(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Expected a YYYY-MM-DD date');
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new Error('Invalid calendar date');
  }
  return ms;
}

function validateConfig(config) {
  if (!/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(config.assignee ?? '')) {
    throw new Error('A valid GitHub assignee is required');
  }
  if (!Array.isArray(config.credentials) || !config.credentials.length) {
    throw new Error('At least one credential expiry must be configured');
  }
  const ids = new Set();
  for (const entry of config.credentials) {
    if (!/^[a-z0-9-]+$/.test(entry.id ?? '') || ids.has(entry.id)) {
      throw new Error('Credential IDs must be unique');
    }
    ids.add(entry.id);
    if (!/^[a-zA-Z0-9_-]+$/.test(entry.name ?? '')) throw new Error('Invalid token name');
    dateMillis(entry.expiresOn);
    if (!Array.isArray(entry.secrets) || !entry.secrets.length ||
        entry.secrets.some(value => !/^[a-z0-9-]+\.[A-Z0-9_]+$/.test(value) &&
          !/^ssm:\/videoq\/security\/prod\/[a-z0-9-]+$/.test(value))) {
      throw new Error('Environment secret or production SSM destinations are required');
    }
  }
}

function stageFor(days) {
  if (days <= 0) return 'expired';
  if (days <= 1) return '1-day';
  if (days <= 7) return '7-days';
  if (days <= 14) return '14-days';
  if (days <= 30) return '30-days';
  return null;
}

function details(entries) {
  return entries.map(entry => `- \`${entry.name}\` → ${entry.secrets.map(s => `\`${s}\``).join(', ')}`).join('\n');
}

async function check({ github, context, core, config, now = new Date(), dryRun = false, previewDate = '' }) {
  if (`${context.repo.owner}/${context.repo.repo}` !== 'videoq-jp/videoq' ||
      context.ref !== 'refs/heads/main' ||
      !['push', 'schedule', 'workflow_dispatch'].includes(context.eventName)) {
    throw new Error('Token reminders may only run on the production repository main branch');
  }
  validateConfig(config);
  if (previewDate && !dryRun) throw new Error('preview_date requires dry_run');
  const today = previewDate || now.toISOString().slice(0, 10);
  const current = dateMillis(today);
  const groups = new Map();
  for (const entry of config.credentials) {
    const group = groups.get(entry.expiresOn) ?? [];
    group.push(entry);
    groups.set(entry.expiresOn, group);
  }

  const report = [`## Cloudflare token expiry${dryRun ? ' (dry run)' : ''}`, '', `UTC date: ${today}`, ''];
  let urgent = false;

  for (const [expiresOn, entries] of groups) {
    const days = (dateMillis(expiresOn) - current) / DAY;
    const stage = stageFor(days);
    report.push(`- ${expiresOn}: ${days} days remaining; ${entries.map(e => e.id).join(', ')}; ${stage ?? 'healthy'}`);
    if (!stage) continue;
    if (days <= 7) urgent = true;
    core.warning(`Cloudflare tokens expire on ${expiresOn} (${days} days remaining)`);
    report.push(details(entries));
  }

  await core.summary.addRaw(`${report.join('\n')}\n`).write();
  if (urgent && !dryRun) {
    core.setFailed('Cloudflare token renewal is due within 7 days or overdue. See the workflow summary.');
  }
  return { today, urgent, dryRun };
}

module.exports = check;
module.exports.validateConfig = validateConfig;
module.exports.stageFor = stageFor;
