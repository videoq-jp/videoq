export function createClient(send) {
  let active = 0;
  const waiting = [];

  async function acquire() {
    if (active < 2) {
      active += 1;
      return;
    }
    await new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  }

  return {
    async request(input, nowSeconds) {
      await acquire();
      try {
        const { status, headers, body } = await send(input);
        if (status >= 200 && status < 300) return { kind: 'ok', value: body };
        if (status === 429) {
          const retryAfter = headers?.['retry-after'];
          const seconds = typeof retryAfter === 'string' && retryAfter.trim() !== ''
            ? Number(retryAfter)
            : NaN;
          const date = Number.isFinite(seconds) ? NaN : Date.parse(retryAfter);
          const retryAt = Number.isFinite(seconds)
            ? nowSeconds + Math.max(0, seconds)
            : Number.isFinite(date) ? Math.max(nowSeconds, date / 1000) : nowSeconds;
          return { kind: 'deferred', retryAt };
        }
        return { kind: 'failed', status };
      } finally {
        release();
      }
    },
  };
}
