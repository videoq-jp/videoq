import { expect, it } from 'vitest';
import { createConnection, createServer } from 'node:net';

it('enforces the reviewed contract', async () => {
  switch (process.env.OWNERSHIP_FAILURE_FIXTURE) {
    case 'assertion': expect(true).toBe(false); break;
    case 'timeout': await new Promise(() => {}); break;
    case 'connection': {
      const server = createServer();
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      await new Promise(resolve => server.close(resolve));
      await new Promise((resolve, reject) => {
        const client = createConnection({ host: '127.0.0.1', port });
        client.once('error', reject);
        client.once('connect', () => { client.destroy(); resolve(); });
      });
      break;
    }
    case 'unhandled':
      void Promise.reject(new Error('out-of-band rejection'));
      await new Promise(resolve => setTimeout(resolve, 20));
      break;
    default: expect(true).toBe(true);
  }
}, process.env.OWNERSHIP_FAILURE_FIXTURE === 'timeout' ? 30 : 5_000);
