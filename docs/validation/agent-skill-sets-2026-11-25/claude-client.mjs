const MAX_IN_FLIGHT = 2;
const MAX_ATTEMPTS = 3;
const NON_IDEMPOTENT = new Set(['POST', 'PATCH']);

function isTemporary(status) {
  return status === 408 || status >= 500;
}

function canRetry(input) {
  const method = String(input.method).toUpperCase();
  return !NON_IDEMPOTENT.has(method) || Boolean(input.idempotencyKey);
}

function retryAtFrom(headers, nowSeconds) {
  const raw = headers?.['retry-after'];
  if (raw == null) return nowSeconds;
  const text = String(raw).trim();
  if (/^\d+$/.test(text)) return nowSeconds + Number(text);
  const date = Date.parse(text);
  if (!Number.isNaN(date)) return Math.max(nowSeconds, Math.ceil(date / 1000));
  return nowSeconds;
}

export function createClient(send) {
  let active = 0;
  const waiting = [];

  async function acquire() {
    if (active < MAX_IN_FLIGHT) {
      active++;
      return;
    }
    // The releasing request hands its slot directly to the next waiter.
    await new Promise((resolve) => waiting.push(resolve));
  }

  function release() {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }

  async function request(input, nowSeconds) {
    await acquire();
    try {
      const retryable = canRetry(input);
      for (let attempt = 1; ; attempt++) {
        const res = await send(input);
        const status = res.status;
        if (status >= 200 && status < 300) return { kind: 'ok', value: res.body };
        if (status === 429) {
          return { kind: 'deferred', retryAt: retryAtFrom(res.headers, nowSeconds) };
        }
        if (isTemporary(status) && retryable && attempt < MAX_ATTEMPTS) continue;
        return { kind: 'failed', status };
      }
    } finally {
      release();
    }
  }

  return { request };
}
