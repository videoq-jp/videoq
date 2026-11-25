# Source evidence

Material: API client and SQL performance course
Source fingerprint: 9924ec2afd917fc9cbb97b580e339a93dec4224bb0092cbde41eb0be0d429c81
Coverage: all subtitle chunks were processed; only facts relevant to the requested task are included below.

## chunk-0-fact-0

Claim: Allow at most two requests in flight.
Applies when: In this lab.

[Client retry policy](https://videoq.example/videos/7?t=10) — 00:00:10,000 → 00:00:30,000

> In this lab allow at most two requests in flight.

## chunk-0-fact-1

Claim: For a 429 response, return a deferred result using Retry-After and let the caller schedule it; the helper must not sleep or retry.
Applies when: A request receives a 429 response.

[Client retry policy](https://videoq.example/videos/7?t=10) — 00:00:10,000 → 00:00:30,000

> A 429 response is deferred using Retry-After: return a deferred result and let the caller schedule it. Never sleep or retry in the helper.

## chunk-0-fact-2

Claim: Treat a 401 response as a permanent authentication failure and do not retry it.
Applies when: A request receives a 401 response.

[Client retry policy](https://videoq.example/videos/7?t=30) — 00:00:30,000 → 00:00:50,000

> A 401 response is a permanent authentication failure. Do not retry it.

## chunk-0-fact-3

Claim: Do not automatically retry a POST without an idempotency key, even after a temporary failure.
Applies when: A POST request has no idempotency key.

[Client retry policy](https://videoq.example/videos/7?t=30) — 00:00:30,000 → 00:00:50,000

> For POST requests without an idempotency key, do not automatically retry even after a temporary failure.

## chunk-0-fact-4

Claim: Use a fake clock and recorded responses to check that active requests never exceed two and that a 429 returns deferred after exactly one request.
Applies when: Testing the lab's retry policy.

[Client retry policy](https://videoq.example/videos/7?t=50) — 00:00:50,000 → 00:01:10,000

> Test the policy with a fake clock and a recorded sequence of responses. Check the active request count never exceeds two and that a 429 produces exactly one request before returning deferred.
