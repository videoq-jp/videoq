// npm audit signatures resolves a peer edge by its installed alias name, e.g.
// react-loadable@6.0.0 instead of @docusaurus/react-loadable@6.0.0.
// Adapt only that identity lookup; npm still verifies every signature and
// provenance attestation and retains its normal failures and exit handling.
const {createRequire} = require('node:module');
const {dirname, resolve} = require('node:path');
const {realpathSync} = require('node:fs');

function canonicalIdentity(edge, info) {
  if (!info) return info;
  const node = edge.to;
  const name = node?.package?.name;
  if (!name || name === info.name) return info;
  // Do not trust an arbitrary name in an installed manifest. Require an
  // explicit alias edge to this same node that names the canonical package.
  const declared = [...node.edgesIn].some(incoming =>
    incoming.to === node && incoming.name === edge.name &&
    (incoming.spec === `npm:${name}` || incoming.spec.startsWith(`npm:${name}@`)));
  if (!declared) throw new Error(`Unexplained package identity mismatch at ${info.location}`);
  return {...info, name};
}

function run(args) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error('Run through npm run audit:signatures with the reviewed npm');
  const npmRoot = resolve(dirname(realpathSync(cli)), '..');
  const npmRequire = createRequire(resolve(npmRoot, 'package.json'));
  const expected = require('../runtime-versions.json').npm;
  if (npmRequire('./package.json').version !== expected) {
    throw new Error(`Signature verification requires reviewed npm ${expected}`);
  }
  const VerifySignatures = npmRequire('./lib/utils/verify-signatures.js');
  const npa = npmRequire('npm-package-arg');
  const original = VerifySignatures.prototype.getValidPackageInfo;
  if (typeof original !== 'function') throw new Error('Unsupported npm signature verifier');
  VerifySignatures.prototype.getValidPackageInfo = function(edge) {
    const info = original.call(this, edge);
    const canonical = canonicalIdentity(edge, info);
    if (!canonical || canonical === info) return info;
    // Select the target package's registry as well as its name for scoped aliases.
    return {...canonical, registry: this.getSpecRegistry(npa.resolve(canonical.name, canonical.version))};
  };
  process.argv = [process.execPath, cli, 'audit', 'signatures', ...args];
  require(cli);
}

module.exports = {canonicalIdentity};
if (require.main === module) run(process.argv.slice(2));
