# Source evidence

Material: Rate-limited API client lab
Source fingerprint: d570bdc2fb822f9d024f85f0b65af1a2f6e04518d16cffbcda32b29ffe3290ac
Coverage: all subtitle chunks were processed; only facts relevant to the requested task are included below.

## chunk-0-fact-0

Claim: Allow at most two requests in flight.
Applies when: Implementing or reviewing the client under this lab policy.

[Client retry policy](https://videoq.example/videos/7?t=10) — 00:00:10,000 → 00:00:30,000

> In this lab allow at most two requests in flight.

## chunk-0-fact-1

Claim: For a 429 response, return a deferred result using Retry-After and let the caller schedule it; the helper must not sleep or retry.
Applies when: A request receives a 429 response.

[Client retry policy](https://videoq.example/videos/7?t=10) — 00:00:10,000 → 00:00:30,000

> A 429 response is deferred using Retry-After: return a deferred result and let the caller schedule it. Never sleep or retry in the helper.

## chunk-0-fact-2

Claim: Treat a 401 as a permanent authentication failure and do not retry.
Applies when: A request receives a 401 response.

[Client retry policy](https://videoq.example/videos/7?t=30) — 00:00:30,000 → 00:00:50,000

> A 401 response is a permanent authentication failure. Do not retry it.

## chunk-0-fact-3

Claim: Do not automatically retry POST requests without an idempotency key, even after a temporary failure.
Applies when: A POST request has no idempotency key.

[Client retry policy](https://videoq.example/videos/7?t=30) — 00:00:30,000 → 00:00:50,000

> For POST requests without an idempotency key, do not automatically retry even after a temporary failure.

## chunk-0-fact-4

Claim: Use a fake clock and recorded response sequence to check that active requests never exceed two and that a 429 returns deferred after exactly one request.
Applies when: Testing the lab policy.

[Client retry policy](https://videoq.example/videos/7?t=50) — 00:00:50,000 → 00:01:10,000

> Test the policy with a fake clock and a recorded sequence of responses. Check the active request count never exceeds two and that a 429 produces exactly one request before returning deferred.
