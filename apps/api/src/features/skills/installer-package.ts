const encoder = new TextEncoder();

/** A small dependency-free npm tarball. Contains installer code, never course data or keys. */
export function installerPackage(origin: string, id: string, script: string): ReadableStream<Uint8Array> {
  const cli = `#!/usr/bin/env node\nimport { main } from './install.mjs';\nmain(${JSON.stringify(['--origin', origin, '--skill', id])}.concat(process.argv.slice(2))).catch(error => { console.error('VideoQ: ' + error.message); process.exitCode = 1; });\n`;
  const files = [
    ['package/package.json', JSON.stringify({ name: 'videoq-skill-installer', version: `0.0.0-skill-${id}`, type: 'module', bin: { 'videoq-skills': 'cli.mjs' }, engines: { node: '>=22' } }), 0o644],
    ['package/cli.mjs', cli, 0o755],
    ['package/install.mjs', script, 0o644],
  ] as const;
  const blocks: Uint8Array[] = [];
  for (const [name, text, mode] of files) {
    const content = encoder.encode(text), header = new Uint8Array(512);
    const write = (offset: number, value: string) => header.set(encoder.encode(value), offset);
    const octal = (offset: number, size: number, value: number) => write(offset, value.toString(8).padStart(size - 1, '0') + '\0');
    write(0, name); octal(100, 8, mode); octal(108, 8, 0); octal(116, 8, 0);
    octal(124, 12, content.length); octal(136, 12, 0);
    header.fill(32, 148, 156); write(156, '0'); write(257, 'ustar\0'); write(263, '00');
    write(148, header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 ');
    blocks.push(header, content, new Uint8Array((512 - content.length % 512) % 512));
  }
  blocks.push(new Uint8Array(1024));
  return new ReadableStream<Uint8Array>({ start(controller) { for (const block of blocks) controller.enqueue(block); controller.close(); } }).pipeThrough(new CompressionStream('gzip'));
}
