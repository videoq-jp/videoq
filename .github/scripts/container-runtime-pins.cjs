// Dockerfiles own image versions; local/CI interpreter pins are independent.
const { readFileSync } = require('node:fs');
function nodeImageVersion(text) {
  const images = text.split(/\r?\n/).filter(line => /^FROM node:/i.test(line));
  if (images.length !== 1) throw new Error('Expected one exact Node image reference');
  const match = images[0].match(/^FROM node:(\d+\.\d+\.\d+)-(?:alpine(?:\d+\.\d+)?|(?:bookworm|trixie|bullseye)(?:-slim)?)@sha256:[a-f0-9]{64}(?:\s+AS\s+[a-z0-9_-]+)?\s*$/i);
  if (!match) throw new Error('Node image must pin a stable version and immutable digest');
  return match[1];
}
if (require.main === module) console.log(nodeImageVersion(readFileSync(process.argv[2], 'utf8')));
module.exports = { nodeImageVersion };
