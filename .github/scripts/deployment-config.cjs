// Runs only from the verified main checkout, with the separately locked tools.
const { readFileSync, writeFileSync, existsSync, lstatSync, readdirSync } = require('node:fs');
const { resolve, join } = require('node:path');

function deploymentConfig(original, component, artifactRoot) {
  if (!['api', 'web', 'docs'].includes(component)) throw new Error('Unknown component');
  const production = component === 'docs' ? original : { ...original, ...original.env?.production };
  if (component !== 'docs') {
    // Wrangler bindings are non-inheritable. A development database must never
    // become the production target merely because env.production omits it.
    for (const key of ['vars', 'hyperdrive', 'r2_buckets', 'durable_objects', 'd1_databases', 'vectorize']) {
      if (!Object.hasOwn(original.env?.production ?? {}, key)) delete production[key];
    }
  }
  if (production.name !== `videoq-${component}`) throw new Error('Unexpected production Worker name');
  // Construct a new config instead of trusting a build-generated config. Do not
  // allow custom build hooks, containers, or programmatic configuration here.
  const keys = ['name', 'compatibility_date', 'compatibility_flags', 'workers_dev', 'preview_urls',
    'observability', 'vars', 'routes', 'hyperdrive', 'r2_buckets', 'durable_objects',
    'migrations', 'triggers', 'rules', 'd1_databases', 'vectorize'];
  const config = Object.fromEntries(keys.filter(key => Object.hasOwn(production, key)).map(key => [key, production[key]]));
  if (component !== 'docs') config.main = join(artifactRoot, component, 'worker', 'index.js');
  if (component === 'web') {
    // Wrangler's bundle adds a content hash to this imported Text module.
    // Include it under its emitted name when uploading without rebundling.
    config.rules = [{ type: 'Text', globs: ['**/_headers', '**/*-_headers'], fallthrough: false }];
    config.preserve_file_names = true;
  }
  if (production.assets) config.assets = { ...production.assets, directory: join(artifactRoot, component, 'assets') };
  config.no_bundle = true;
  return config;
}

function rejectSymlinks(directory) {
  if (!existsSync(directory)) throw new Error(`Missing deployment artifact: ${directory}`);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (lstatSync(path).isSymbolicLink()) throw new Error(`Artifact symlink rejected: ${path}`);
    if (entry.isDirectory()) rejectSymlinks(path);
  }
}

if (require.main === module) {
  const [component, artifactDirectory, destination] = process.argv.slice(2);
  if (!['api', 'web', 'docs'].includes(component)) throw new Error('Unknown component');
  const { parse } = require('../deploy-tools/node_modules/jsonc-parser');
  const errors = [];
  const original = parse(readFileSync(`apps/${component}/wrangler.jsonc`, 'utf8'), errors);
  if (errors.length) throw new Error('Invalid trusted Wrangler configuration');
  const artifactRoot = resolve(artifactDirectory);
  rejectSymlinks(join(artifactRoot, component));
  const config = deploymentConfig(original, component, artifactRoot);
  if (config.main && !existsSync(config.main)) throw new Error('Missing prebuilt Worker');
  if (config.assets && !existsSync(config.assets.directory)) throw new Error('Missing static assets');
  writeFileSync(destination, JSON.stringify(config, null, 2));
}

module.exports = { deploymentConfig, rejectSymlinks };
