# Cloudflare resources for VideoQ

## Account and billing

VideoQ stays in the existing account `12daec56fdba43f677f2766ee26a5a39`.
The operator chose shared billing on 2026-11-17. Do not provision a second
Workers Paid subscription or transfer the production zone as part of resource
organization. Tags classify resources; they do not create a billing or access
control boundary.

In the dashboard, open **Manage Account → Resource Tagging** and filter by
`project=videoq`. All seven production resources below were tagged and read back
on 2026-11-17 with `project=videoq` and `environment=production`.

| Resource type | Current physical name | Component tag | Intended name for a future replacement |
| --- | --- | --- | --- |
| D1 | `videoq-d1-migration-staging-v4` | `database` | `videoq-prod-db` |
| Vectorize | `videoq-scenes-migration-v3-1536` | `scene-search-1536` | `videoq-prod-scenes-1536` |
| Vectorize | `videoq-scenes-migration-v3-768` | `scene-search-768` | `videoq-prod-scenes-768` |
| Worker | `videoq-api` | `api` | Keep current name |
| Worker | `videoq-web` | `web` | Keep current name |
| Worker | `videoq-docs` | `docs` | Keep current name |
| R2 | `videoq-media-prod` | `media` | Keep current name |

The live D1 database ID is `e57d0931-18cb-4f00-ae7f-b0068030fb04`.
Names containing `migration` or `staging` in this table are still production
resources. They must not be deleted as rehearsal artifacts.

## Naming work still required

Tagging is complete for the table above. Physical D1 and Vectorize names have
not changed. The documented APIs do not provide a direct rename operation for
these resources. Editing the name in Wrangler alone does not rename a resource.

A replacement must preserve data and authentication state, vector dimensions,
metric and metadata indexes; verify ownership filters and search quality; drain
writers; switch bindings and the reviewed AWS maintenance target configuration;
and verify production before retiring the previous resources. Keep the existing
account, billing, R2 bucket, Worker identities, secrets and DNS while doing this.
Use the existing migration and recovery runbooks for the data validation gates.

## Scope exclusions and temporary account

Resources belonging to other projects are not tagged or changed. Older rehearsal
resources and `videoq-design-review` need a separate ownership and usage check
before being classified or deleted.

The accidentally created, empty `VideoQ` account
`3663df35267b7e3368c2cefdc370ea35` has no subscriptions. Its individual deletion
was requested by the operator, but the documented API returned HTTP 403/code1002.
Support case #02436355 was submitted with the operator’s explicit authorization;
account deletion remains pending. Never delete the user profile to remove this account:
that can also delete the existing production account.

## References

- [Resource Tagging](https://developers.cloudflare.com/resource-tagging/)
- [Supported resource types](https://developers.cloudflare.com/resource-tagging/reference/resource-types/)
- [Manage tags](https://developers.cloudflare.com/resource-tagging/how-to/manage-tags/)
- [Account deletion API](https://developers.cloudflare.com/api/resources/accounts/methods/delete/)

## Private vector copy preparation

`infra/scripts/snapshot_scene_vectors.py` reads the fixed current indexes using
only index info, paginated ID listing and `get_by_ids` (at most 20 IDs per call).
It preserves vector values, metadata and namespaces. REST `namespace: null`
means the default namespace and is normalized to omission for later upsert.
It does not call an embedding model or write any remote resource.

Supply an operator token privately in `CLOUDFLARE_API_TOKEN`, create an empty
mode-0700 output directory, then run:

```sh
python3 infra/scripts/snapshot_scene_vectors.py --output-dir /private/vector-copy
```

The tool refuses duplicate/missing IDs, invalid dimensions/non-finite values,
changed index-info or changed ID inventory. Output files are mode 0600 and a
failed snapshot removes files it created. Keep the NDJSON out of Git, logs and
CI artifacts; delete it after migration verification. Aggregate receipts contain
counts and hashes. Repeated reads are diagnostic consistency checks and do not
prove writer quiescence or provide an atomic snapshot. Final transfer must run
under the reviewed maintenance hold, writer drain and deployment exclusion.
