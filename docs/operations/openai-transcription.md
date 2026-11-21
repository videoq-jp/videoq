# Cloud AI: OpenRouter

The hosted profiles use OpenRouter for all AI calls. The preferred authentication
is AWS workload identity federation; a fixed `OPENROUTER_API_KEY` remains an
explicit development compatibility option.

| Use | Model | Endpoint |
| --- | --- | --- |
| Answers and image inspection | `openai/gpt-6-luna` | `/api/v1/chat/completions` |
| Query and indexing embeddings | `openai/text-embedding-3-small` | `/api/v1/embeddings` |
| Transcription | `openai/whisper-large-v3-turbo` | `/api/v1/audio/transcriptions` |

LLM and embedding models are unchanged. The OpenRouter namespace is a routing
alias, so existing 1536-dimensional vectors can be retained. Keep API and worker
embedding configuration identical. On-premises inference still uses `local`.

## Workload identity federation (preferred)

OpenRouter WIF requires Business or Enterprise. As of 2026-10-30, Business has
no monthly minimum or seat fee and charges 8% on credit purchases (Standard:
5.5%). Upgrading the account is an administrator action; deploying this code does
not change the plan. [Business pricing](https://openrouter.ai/business).

The runtime flow is regional AWS STS `GetWebIdentityToken` (RS256, 900 seconds),
then OpenRouter `/api/v1/oauth/token` with the registered federation policy ID.
Only inference-scoped bearer tokens are accepted. Tokens stay in memory and are
refreshed at least 60 seconds before expiry. A configured policy takes precedence
over old OpenRouter/purpose keys; an exchange failure never falls back to them.

1. Enable AWS outbound web identity federation for the AWS account. Record the
   account-specific issuer URL from IAM. This account setting must be enabled
   by an AWS administrator; this repository does not enable it automatically.
2. In OpenRouter Settings → Workload identity, register the AWS issuer and create
   separate policies for the Lambda role and API's AWS principal. Set audience
   to `https://openrouter.ai`, pin `Subject` to each principal's exact ARN from
   its STS JWT `sub`, and target an organization workspace inference key.
   Personal keys and management-scoped policies are unsuitable for inference.
   The target workspace key remains in OpenRouter; do not copy it into runtimes.
3. Allow `sts:GetWebIdentityToken` for the intended principal, with audience,
   algorithm and duration restrictions. Lambda Terraform adds this permission
   when `openrouter_federation_policy_id` is set. The externally managed API
   principal can use [the IAM policy template](../../infra/iam/videoq-openrouter-federation.json).
4. For Lambda, set Terraform `openrouter_federation_policy_id` to the worker's
   policy ID. For the API, set `OPENROUTER_FEDERATION_POLICY_ID` and `AWS_REGION`
   in the production Wrangler vars. Policy IDs/audiences are non-secret. Keep
   the optional audience variable identical on AWS and OpenRouter.
5. Lambda uses its execution role through boto3. Cloudflare Workers use the
   existing `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (and session token if
   supplied) through SigV4. This removes the OpenRouter fixed key; it does not
   eliminate Cloudflare's existing AWS credentials. Local Python development
   may use the normal boto3 credential chain; the API needs AWS env credentials.
6. Run the preflight below, then the complete disposable upload/index/search
   check before releasing. Remove obsolete fixed OpenRouter and purpose-key
   secrets once federation works. Never save exchanged JWTs or access tokens.

To inspect account readiness without changing AWS settings:

```sh
python infra/scripts/openrouter_identity.py --region ap-northeast-1
```

The command uses the boto3 credential chain and reports missing credentials,
disabled federation, or the issuer URL. An AWS administrator can explicitly
add `--enable` to enable account outbound federation. After granting STS token
permission, use `--probe` as each intended workload identity to obtain its exact
subject for the OpenRouter policy; the token itself is never printed.

For CI, set the non-secret GitHub variable
`OPENROUTER_WORKER_FEDERATION_POLICY_ID` to the Lambda policy ID and optionally
`OPENROUTER_FEDERATION_AUDIENCE`. Both the Terraform plan and apply workflows
pass those values into Terraform, preventing the default empty ID from silently
disabling WIF. The API's policy remains in production Wrangler vars. These IDs
must target the corresponding workload subjects; do not reuse the Lambda policy
for a different API principal.

OpenRouter's endpoint validates the AWS issuer, audience, subject and signature.
Business support, issuer/policy provisioning and account IAM access must exist
before the live probe can succeed. Keep production untouched until those steps
and the probes are complete.

Sources: [OpenRouter WIF](https://openrouter.ai/docs/guides/overview/auth/workload-identity-federation),
[AWS STS API](https://docs.aws.amazon.com/STS/latest/APIReference/API_GetWebIdentityToken.html),
[AWS token claims](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_outbound_token_claims.html).

## Release order

1. Provision the workload identity policies above and configure the API/worker
   policy IDs. For explicit fixed-key development only, provide
   `OPENROUTER_API_KEY`. Never commit keys or print secret payloads.
2. Remove stale LLM/embedding endpoint and key overrides when using the unified
   provider. Review deployment overrides for `WHISPER_BACKEND`; the hosted
   profile uses `openrouter`, while an explicitly selected `openai` backend
   continues to call OpenAI directly. The shared hosted URL is
   `https://openrouter.ai/api/v1`.
3. Before deploying, use a short non-sensitive audio fixture to verify
   `verbose_json` and `timestamp_granularities=["segment"]` with the specified
   Whisper model. The adapter rejects text-only transcripts without real
   timestamps. Check a structured answer with tool calling, images and streaming,
   and validate an embedding response has 1536 finite components.
4. Check in-flight transcription runs and queued/active jobs before switching
   worker versions. Existing transcripts, usage reservations and saved chunks
   must be retained. Chunk intervals remain 300 seconds for the hosted profile.
5. Deploy the matching API and Lambda code through CD before approving the
   initial Terraform activation. The current worker must understand the
   `openrouter` backend before Terraform changes its environment. For this
   migration, wait until CD has updated the Lambda image, then approve the
   pending production-infra apply. SSM values are cached per warm container;
   a new worker version/configuration is required to load changed settings.
6. Verify a complete new upload, transcription offsets, indexing and Q&A. Check
   actual provider/model usage in OpenRouter. No production switch is proven
   merely by changing repository configuration.

After the Lambda environment activation has completed, run the production smoke
with one temporary AI answer allowed:

```sh
gh workflow run operations.yml --ref main -f check=smoke -f verify_ai_answers=true
```

This uploads the reviewed synthetic fixture under a temporary low-quota user,
checks processing and indexing, asks one question scoped to its temporary course,
and requires a transcript citation to the uploaded video. Cleanup removes the
synthetic video and course before deleting the user. The flag defaults to false
for routine checks. Never overlap this migration check with the initial
Terraform activation or count a health-only check as inference verification.

## Run the model preflight

Put `OPENROUTER_FEDERATION_POLICY_ID`, `AWS_REGION` and the local AWS workload
credentials in the root `.env` (ignored by Git) or API `.dev.vars`. A development
`OPENROUTER_API_KEY` can be used if WIF is not yet configured. The command checks both locations and uses a process variable
first. Install the API dependencies and worker Python dependencies, then run
from the repository root with a short, non-sensitive speech fixture:

```sh
VIDEOQ_TEST_PYTHON=/path/to/worker-venv/bin/python npm run openrouter:check --workspace @videoq/api -- /absolute/path/speech.flac
```

The default checks prerequisites without calling a model. Add `--probe` to make
paid calls and upload the supplied speech file and the repository's public icon:

```sh
VIDEOQ_TEST_PYTHON=/path/to/worker-venv/bin/python npm run openrouter:check --workspace @videoq/api -- /absolute/path/speech.flac --probe
```

This uses the application adapters to check structured answers, streaming,
tool calling followed by a final answer, image input, API query embeddings,
worker transcription timestamps and worker indexing embeddings. It selects the
three requested OpenRouter models independently of stale local overrides. Output
contains status/counts only; transcripts, images, vectors and keys are not logged.
It does not write application data or deploy services. A successful model
preflight still requires a complete upload/index/search test in a disposable
application environment before production. The optional `EMBEDDING_LIVE=1`
integration test uses `EMBEDDING_TEST_DATABASE_URL` to create a temporary database
and verifies Python indexing plus API retrieval and Q&A.

## Compatibility and provider controls

OpenRouter supports OpenAI-compatible multipart transcription and `verbose_json`.
Structured fields vary by upstream provider; no subtitle timestamps are invented
if an endpoint does not return them. The model page lists DeepInfra and Groq as
providers. Transcription routing does not apply `provider.order`, `only` or
`ignore`; do not assume those parameters pin an upstream speech provider.

Data passes through OpenRouter and an upstream provider. Review their current
logging/retention policies when deploying; OpenAI-direct endpoint retention
claims do not automatically apply to this route. Existing plan allowances and
usage accounting are unchanged. Older planning estimates for hosted `whisper-1`
are historical assumptions, not prices or invoices for this model.

Sources (checked 2026-10-30):
[Whisper model and providers](https://openrouter.ai/openai/whisper-large-v3-turbo),
[transcription API](https://openrouter.ai/docs/guides/overview/multimodal/stt),
[embeddings API](https://openrouter.ai/docs/api_reference/embeddings).

## Retiring the previous direct credentials

Keep the organization workspace key targeted by each OpenRouter federation policy.
Revoking that key would invalidate the federation path. The old direct OpenAI
project keys are separate from those workspace keys and from the OpenAI admin
key still used by Terraform project governance.

After a successful production smoke with `verify_ai_answers=true`, dispatch
`ai-credential-audit.yml` to inventory the remaining runtime copies without
printing their values. The guarded `retire-ai-credentials.yml` defaults to `plan`;
it also audits the API IAM user's policies and key ages using read-only calls.
Review the project identity, key names/IDs, the worker key's unique match to a
provider-redacted key, the SSM version, and both runtimes' federation configuration.

For `operation=retire`, supply only the reviewed key IDs as a JSON array and
`expected_ssm_version` from that plan. The script removes `OPENAI_API_KEY` from
the worker app parameter and the production API, verifies both removals, revokes
only the selected keys in the dedicated `videoq-prod` OpenAI project, and verifies
the result. It preserves other SSM fields and the current encryption key, refuses
concurrent parameter changes detected before writes, and never calls OpenRouter's
management API. SSM's retained old parameter versions can contain the old key;
provider-side revocation makes those copies unusable. If a step is interrupted,
run `plan` again and review the new SSM version before retrying the same IDs;
already absent project keys can be reverified safely.

Use the normal production-infra gate and rerun the production smoke after
retirement. Removing copies alone does not prove provider-side revocation.
AWS IAM key rotation is a separate change: keep the previous key active until
the replacement has passed the full upload/index/Q&A check.
