export function createClient(send) {
  let active = 0;
  const waiting = [];

  async function acquire() {
    if (active < 2) {
      active++;
      return;
    }
    await new Promise(resolve => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  return {
    async request(input, nowSeconds) {
      await acquire();
      try {
        const { status, headers, body } = await send(input);
        if (status >= 200 && status < 300) return { kind: 'ok', value: body };
        if (status === 429) {
          const value = headers['retry-after'];
          const seconds = typeof value === 'string' && /^\s*\d+\s*$/.test(value)
            ? Number(value)
            : typeof value === 'number' && Number.isFinite(value) && value >= 0
              ? value
              : null;
          const date = seconds === null && typeof value === 'string' ? Date.parse(value) : NaN;
          const retryAt = seconds !== null ? nowSeconds + seconds
            : Number.isFinite(date) ? Math.max(nowSeconds, date / 1000)
              : nowSeconds;
          return { kind: 'deferred', retryAt };
        }
        return { kind: 'failed', status };
      } finally {
        release();
      }
    },
  };
}
