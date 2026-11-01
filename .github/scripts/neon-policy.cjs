// Login roles rotate; these NOLOGIN roles keep grants and schema ownership stable.
const {gzipSync,gunzipSync}=require('node:zlib');
const OWNER = 'videoq_migrate_20260918';
const PROFILES = Object.freeze(require('./neon-profiles.json'));
const JOURNAL = '/videoq/security/prod/db-rotation';
const ROTATE_AFTER_DAYS = 90;
function loginName(purpose, generation) {
  if (!Object.hasOwn(PROFILES, purpose) || !/^\d{14}_[a-f0-9]{8}$/.test(generation)) throw new Error('INVALID_ROTATION_ID');
  return `videoq_${purpose}_${generation}`;
}
function connectionUrl(template, purpose, user, password) {
  const profile = PROFILES[purpose];
  if (!profile) throw new Error('UNKNOWN_DATABASE_PURPOSE');
  const url = new URL(template);
  if (!url.hostname.endsWith('.aws.neon.tech') || !['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('UNEXPECTED_DATABASE_HOST');
  url.hostname = url.hostname.replace('-pooler.', '.');
  if (profile.pooled) { const [endpoint, ...domain] = url.hostname.split('.'); url.hostname = endpoint + '-pooler.' + domain.join('.'); }
  url.username = user; url.password = password;
  url.searchParams.set('sslmode', 'verify-full');
  url.searchParams.delete('options');
  if (purpose === 'migration') url.searchParams.set('options', `-c role=${OWNER}`);
  return url.toString();
}
function retirementRole(purpose, user) {
  const prefix={api:'(?:app|api)',migration:'(?:migrate|migration)',worker:'worker',backup:'backup',audit:'audit',smoke:'smoke',demo:'demo'}[purpose];
  if(!prefix||!new RegExp('^videoq_'+prefix+'_[a-zA-Z0-9_]+$').test(user)) throw new Error('UNEXPECTED_RETIREMENT_ROLE');
  return user;
}
function encodeJournal(value) {
  const encoded=JSON.stringify({format:'gzip-base64-v1',payload:gzipSync(JSON.stringify(value)).toString('base64')});
  if(Buffer.byteLength(encoded)>4096) throw new Error('ROTATION_JOURNAL_TOO_LARGE');
  return encoded;
}
function decodeJournal(value) {
  if(value.format!=='gzip-base64-v1') throw new Error('INVALID_ROTATION_JOURNAL_FORMAT');
  return JSON.parse(gunzipSync(Buffer.from(value.payload,'base64'),{maxOutputLength:65536}).toString());
}
module.exports = { OWNER, PROFILES, JOURNAL, ROTATE_AFTER_DAYS, loginName, connectionUrl, encodeJournal, decodeJournal, retirementRole };
