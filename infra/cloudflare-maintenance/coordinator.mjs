// One coordination atom per production database, not per HTTP/application request.
// Locks have no TTL: cancellation, eviction and a failed job never reopen writers.
export const PLAN_KEYS = new Set(['background-queues','background-drain','background-workflows','background-restore','background-schema-complete','operation-result']);
const hex = bytes => [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2,'0')).join('');
export const digest = async value => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value))));
export const runKey = identity => digest(`github:${identity.kind}:${identity.runId}`).then(value => value.slice(0,32));
export class CoordinatorStore {
  constructor(storage, now = Date.now) {
    this.storage = storage; this.sql = storage.sql; this.now = now;
    this.sql.exec('CREATE TABLE IF NOT EXISTS maintenance_runs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, github_run TEXT NOT NULL, attempt INTEGER NOT NULL, source TEXT NOT NULL, state TEXT NOT NULL, writers_stopped INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS maintenance_owner (singleton INTEGER PRIMARY KEY CHECK(singleton=1), run TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS maintenance_plans (run TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY(run,name))');
  }
  row(id) { return this.sql.exec('SELECT * FROM maintenance_runs WHERE id=?', id).toArray()[0]; }
  owner() { return this.sql.exec('SELECT run FROM maintenance_owner WHERE singleton=1').toArray()[0]?.run; }
  recovery(id, identity) {
    const row = this.row(id);
    return Boolean(row && this.owner() === id && row.source === identity.source && row.kind === identity.kind && row.github_run === identity.runId);
  }
  owned(id, identity) {
    const row = this.row(id);
    if (!row || this.owner() !== id || row.source !== identity.source || row.kind !== identity.kind || row.github_run !== identity.runId || row.attempt !== identity.attempt) throw Error('MAINTENANCE_OWNERSHIP_REQUIRED');
    return row;
  }
  metadata(row) { return { run:row.id, kind:row.kind, source:row.source, attempt:row.attempt, state:row.state, writersStopped:Boolean(row.writers_stopped) }; }
  async operate(id, identity, body) {
    const action = body.action;
    if (!['acquire','assert','load','save','complete','release','fail'].includes(action)) throw Error('INVALID_MAINTENANCE_ACTION');
    if (Object.keys(body).some(k => !['action','writersStopped','key','value'].includes(k))) throw Error('INVALID_MAINTENANCE_REQUEST');
    if (['load','save'].includes(action) && !PLAN_KEYS.has(body.key)) throw Error('INVALID_MAINTENANCE_PLAN');
    let encoded, hash;
    if (action === 'save') {
      encoded = JSON.stringify(body.value);
      if (encoded === undefined || new TextEncoder().encode(encoded).length > 64000) throw Error('MAINTENANCE_PLAN_TOO_LARGE');
      hash = await digest(body.value);
    }
    return this.storage.transactionSync(() => {
      if (action === 'acquire') {
        if (typeof body.writersStopped !== 'boolean' || (identity.kind === 'smoke' && body.writersStopped)) throw Error('INVALID_MAINTENANCE_REQUEST');
        const owner = this.owner(), row = this.row(id);
        if (owner && owner !== id) throw Error('MAINTENANCE_BUSY');
        if (row) {
          if (row.source !== identity.source || row.kind !== identity.kind || row.github_run !== identity.runId || Boolean(row.writers_stopped) !== body.writersStopped) throw Error('MAINTENANCE_RUN_CHANGED');
          // Idempotent lost-response retry is allowed. A failed attempt requires a
          // real, later GitHub run attempt, verified by the public entry point.
          if (row.state === 'released') return this.metadata(row);
          if (identity.attempt < row.attempt || (row.state === 'failed' && identity.attempt <= row.attempt)) throw Error('MAINTENANCE_RECOVERY_REQUIRED');
          if (owner !== id) throw Error('MAINTENANCE_OWNERSHIP_REQUIRED');
          this.sql.exec('UPDATE maintenance_runs SET attempt=?, state=?, updated_at=? WHERE id=?',identity.attempt,row.state === 'completed'?'completed':'running',this.now(),id);
        } else {
          this.sql.exec('INSERT INTO maintenance_runs VALUES(?,?,?,?,?,?,?,?)',id,identity.kind,identity.runId,identity.attempt,identity.source,'running',Number(body.writersStopped),this.now());
          this.sql.exec('INSERT INTO maintenance_owner VALUES(1,?)',id);
        }
        return this.metadata(this.row(id));
      }
      const released = this.row(id);
      if (action === 'release' && released?.state === 'released' && released.source === identity.source && released.kind === identity.kind && released.github_run === identity.runId && released.attempt === identity.attempt) return this.metadata(released);
      const row = this.owned(id,identity);
      if (action === 'assert') { if (row.state !== 'running') throw Error('MAINTENANCE_NOT_RUNNING'); return this.metadata(row); }
      if (action === 'load') {
        const plan = this.sql.exec('SELECT value FROM maintenance_plans WHERE run=? AND name=?',id,body.key).toArray()[0];
        return { value:plan ? JSON.parse(plan.value):null };
      }
      if (action === 'save') {
        if (row.state !== 'running') throw Error('MAINTENANCE_NOT_RUNNING');
        const old = this.sql.exec('SELECT value,digest FROM maintenance_plans WHERE run=? AND name=?',id,body.key).toArray()[0];
        if (old && (old.digest !== hash || old.value !== encoded)) throw Error('MAINTENANCE_PLAN_IMMUTABLE');
        if (!old) this.sql.exec('INSERT INTO maintenance_plans VALUES(?,?,?,?)',id,body.key,encoded,hash);
        return { saved:true };
      }
      if (action === 'complete') {
        if (!['running','completed'].includes(row.state)) throw Error('MAINTENANCE_NOT_RUNNING');
        const saved = this.sql.exec('SELECT value FROM maintenance_plans WHERE run=? AND name=?',id,'operation-result').toArray()[0];
        const proof = saved ? JSON.parse(saved.value):null;
        if (!proof || proof.version !== 1 || proof.kind !== row.kind || proof.run !== id || proof.source !== row.source
          || (row.kind === 'smoke' && proof.syntheticCleanupComplete !== true)
          || (row.kind === 'migration' && (row.writers_stopped ? proof.backgroundRestored !== true : proof.readOnly !== true))) throw Error('MAINTENANCE_COMPLETION_PROOF_REQUIRED');
        this.sql.exec('UPDATE maintenance_runs SET state=?,updated_at=? WHERE id=?','completed',this.now(),id);
      } else if (action === 'release') {
        if (row.state !== 'completed') throw Error('MAINTENANCE_COMPLETION_PROOF_REQUIRED');
        this.sql.exec('DELETE FROM maintenance_owner WHERE singleton=1 AND run=?',id);
        this.sql.exec('UPDATE maintenance_runs SET state=?,updated_at=? WHERE id=?','released',this.now(),id);
      } else if (action === 'fail') {
        if (row.state !== 'running') throw Error('MAINTENANCE_NOT_RUNNING');
        this.sql.exec('UPDATE maintenance_runs SET state=?,updated_at=? WHERE id=?','failed',this.now(),id);
      }
      return this.metadata(this.row(id));
    });
  }
}
