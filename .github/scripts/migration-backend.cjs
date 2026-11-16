// Canonical production config selects the migration dialect; no fallback on a
// malformed or incomplete D1 selection. Application code is not loaded here.
function migrationTarget(config) {
  const production = config?.env?.production, vars = production?.vars;
  if (production?.name !== 'videoq-api' || vars?.ENVIRONMENT !== 'production') throw Error('INVALID_MIGRATION_CONFIGURATION');
  if (vars.DEPLOYMENT_EDITION !== undefined && vars.DEPLOYMENT_EDITION !== 'cloud') throw Error('INVALID_MIGRATION_CONFIGURATION');
  const backend = vars.PERSISTENCE_BACKEND ?? (vars.DEPLOYMENT_EDITION === 'cloud' ? 'd1' : 'postgres');
  if (!['postgres','d1'].includes(backend)) throw Error('INVALID_MIGRATION_CONFIGURATION');
  if (backend === 'postgres') {
    if (vars.DEPLOYMENT_EDITION === 'cloud' && vars.MIGRATION_ALLOW_CLOUD_POSTGRES !== 'true') throw Error('INVALID_MIGRATION_CONFIGURATION');
    return {backend, production};
  }
  if (vars.DEPLOYMENT_EDITION !== 'cloud' || vars.MIGRATION_ALLOW_CLOUD_POSTGRES !== undefined) throw Error('INVALID_MIGRATION_CONFIGURATION');
  const databases = production.d1_databases;
  if (!Array.isArray(databases) || databases.length !== 1 || databases[0].binding !== 'DB'
    || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(databases[0].database_id ?? '')
    || /^0+-0+-0+-0+-0+$/.test(databases[0].database_id) || !databases[0].database_name
    || databases[0].migrations_dir !== 'drizzle-d1' || databases[0].migrations_pattern !== undefined) throw Error('INVALID_D1_MIGRATION_CONFIGURATION');
  const indexes = ['SCENE_VECTORIZE_1536','SCENE_VECTORIZE_768'].map(name => {
    const matches = (production.vectorize ?? []).filter(binding => binding.binding === name);
    if (matches.length !== 1 || typeof matches[0].index_name !== 'string' || !matches[0].index_name) throw Error('INVALID_D1_MIGRATION_CONFIGURATION');
    return matches[0].index_name;
  });
  if (indexes[0] === indexes[1]) throw Error('INVALID_D1_MIGRATION_CONFIGURATION');
  return {backend, production};
}
module.exports = {migrationTarget};
