/** Export exact theme colors from the editable SVG master. */
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(root, 'assets/brand/icon.svg');
const exports = {
  'assets/brand/icon-master.png': 1254,
  'assets/brand/github-organization.png': 1024,
  'apps/web/public/logo.png': 512,
  'apps/web/public/logo512.png': 512,
  'apps/web/public/logo192.png': 192,
  'apps/web/public/apple-touch-icon.png': 180,
  'apps/docs/static/img/videoq-icon.png': 192,
  'apps/demo-video/public/brand/videoq.png': 512,
};
for (const [destination, size] of Object.entries(exports)) {
  await sharp(source).resize(size, size).png().toFile(resolve(root, destination));
}
// ICO permits PNG-encoded entries, preserving alpha and the same SVG render.
const sizes = [16, 32, 48];
const frames = await Promise.all(sizes.map(size => sharp(source).resize(size, size).png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (const [index, size] of sizes.entries()) {
  const position = 6 + index * 16;
  header[position] = size;
  header[position + 1] = size;
  header.writeUInt16LE(1, position + 4);
  header.writeUInt16LE(32, position + 6);
  header.writeUInt32LE(frames[index].length, position + 8);
  header.writeUInt32LE(offset, position + 12);
  offset += frames[index].length;
}
for (const destination of ['apps/web/public/favicon.ico', 'apps/docs/static/img/favicon.ico']) {
  await writeFile(resolve(root, destination), Buffer.concat([header, ...frames]));
}
console.log(`Exported ${Object.keys(exports).length} PNGs and 2 favicons from icon.svg.`);
