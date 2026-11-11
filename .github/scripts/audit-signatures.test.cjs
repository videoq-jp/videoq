const assert = require('node:assert/strict');
const {test} = require('node:test');
const {canonicalIdentity} = require('./audit-signatures.cjs');

function aliasedPeer(name = '@docusaurus/react-loadable', spec = `npm:${name}@6.0.0`) {
  const node = {package: {name}, edgesIn: new Set()};
  const edge = {name: 'react-loadable', spec: '*', to: node};
  node.edgesIn.add({name: edge.name, spec, to: node});
  return edge;
}
const info = {name: 'react-loadable', version: '6.0.0', location: 'node_modules/react-loadable', registry: 'https://registry.npmjs.org/'};

test('peer dependency uses the canonical target of a declared npm alias', () => {
  const result = canonicalIdentity(aliasedPeer(), info);
  assert.deepEqual(result, {...info, name: '@docusaurus/react-loadable'});
  assert.equal(info.name, 'react-loadable');
});

test('unversioned explicit aliases are also recognized', () => {
  assert.equal(canonicalIdentity(aliasedPeer('@scope/target', 'npm:@scope/target'), info).name, '@scope/target');
});

test('ordinary and already canonical edges retain the original verification info', () => {
  assert.equal(canonicalIdentity({to: {package: {name: info.name}}}, info), info);
  const canonical = {...info, name: '@docusaurus/react-loadable'};
  assert.equal(canonicalIdentity(aliasedPeer(), canonical), canonical);
  assert.equal(canonicalIdentity(aliasedPeer(), undefined), undefined);
});

test('unexplained installed manifest names fail closed', () => {
  for (const spec of ['*', 'file:../target', 'npm:@scope/target-other@6.0.0']) {
    assert.throws(() => canonicalIdentity(aliasedPeer('@scope/target', spec), info), /identity mismatch/);
  }
});

test('an alias on another installed node or with another alias name cannot authorize a rewrite', () => {
  for (const field of ['to', 'name']) {
    const edge = aliasedPeer();
    const declaration = [...edge.to.edgesIn][0];
    declaration[field] = field === 'to' ? {} : 'another-alias';
    assert.throws(() => canonicalIdentity(edge, info), /identity mismatch/);
  }
});
