const MAX_IN_FLIGHT = 2;

function retryAfterSeconds(value, nowSeconds) {
  if (value === undefined || value === null) return nowSeconds;
  const text = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(text)) return nowSeconds + Number(text);
  const dateMs = Date.parse(text);
  if (Number.isFinite(dateMs)) return Math.max(nowSeconds, dateMs / 1000);
  return nowSeconds;
}

export function createClient(send) {
  let active = 0;
  const waiters = [];

  async function acquire() {
    if (active < MAX_IN_FLIGHT) {
      active++;
      return;
    }
    // The releasing request hands its slot directly to the next waiter.
    await new Promise((resolve) => waiters.push(resolve));
  }

  function release() {
    const next = waiters.shift();
    if (next) next();
    else active--;
  }

  async function request(input, nowSeconds) {
    await acquire();
    let response;
    try {
      response = await send(input);
    } finally {
      release();
    }

    const { status, headers = {}, body } = response;
    if (status >= 200 && status < 300) {
      return { kind: 'ok', value: body };
    }
    if (status === 429) {
      // Caller schedules the retry; the helper never sleeps or retries.
      return { kind: 'deferred', retryAt: retryAfterSeconds(headers['retry-after'], nowSeconds) };
    }
    // 401 is a permanent auth failure; other failures are not retried
    // automatically (in particular POSTs without an idempotency key).
    return { kind: 'failed', status };
  }

  return { request };
}
