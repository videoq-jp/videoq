# Dependency update ownership across videoq-jp

The organization inventory on 2026-11-27 contains five repositories. Ordinary
package and container updates belong to Dependabot. Runtime generation, upstream
code migrations, CI compatibility repairs and merge authorization have separate
responsibilities; they are not replaced by a second package-update bot.

| Repository | Dependabot manifests | Remaining custom work |
| --- | --- | --- |
| videoq | npm workspaces and standalone deployment/operations/DB-maintenance tools; uv projects; Actions; Docker/Compose; Terraform; optional whisper.cpp submodule; bootstrap npm/pip/uv manifests; on-prem verification and Ansible requirements | Node/Python interpreter discovery; exact bootstrap distribution verification and rendering; native recipe/provenance coordination; upstream compatibility; bounded Claude repairs and queue authorization |
| langchainjs-optchat | Root npm dependencies; Actions; bootstrap npm; standalone consumer and Durable Object example manifests | Node interpreter discovery; exact npm verification/rendering; upstream source/API migrations; bounded Claude repairs and queue authorization |
| langchainjs-postgres | Root npm dependencies; Actions; bootstrap npm | Node interpreter discovery; exact npm verification/rendering; upstream submodule/API migrations; bounded Claude repairs and queue authorization |
| shadcn-digital-agency-jp | Root npm dependencies; Actions; bootstrap npm | Node interpreter discovery; exact npm verification/rendering; upstream component migrations; bounded Claude repairs and queue authorization |
| videoq-moodle | Shared image manifest in `lab/images/compose.yaml`; coding-tool Composer manifest and lock in `.github/moodle-codecheck` | PHP-only tooling, Moodle/browser compatibility checks and upstream source pins; no Node/Python bootstrap automation to migrate |

Moodle already routes its image consumers through one Compose manifest and uses
Dependabot for the Composer tools. Its workflows deliberately use no JavaScript
Actions, and it has no npm/uv project. No new ecosystem is needed there. The
upstream submodules in the two library/UI repositories feed compatibility work;
blind submodule bumps do not replace those migrations.

## Bootstrap update sequence

1. Dependabot opens a PR changing the exact bootstrap version in
   `.github/runtime-tools/package.json` (npm), or `requirements.txt` (pip/uv in
   videoq). These source PRs are reviewed; existing protected-file policies apply.
2. After merge, the existing daily Runtime Updates run reads the requested pin.
   It queries only that exact release for official download URLs and hashes,
   without searching npm/PyPI/GitHub release catalogs for newer tools.
3. Runtime Updates proposes the applied runtime manifest and generated local/CI
   files together. Existing current/new-series review and CI/queue policies apply.

This intentionally retains a second generated PR. It avoids introducing a new
privileged workflow that mutates Dependabot branches or broadening their trusted
provenance rules. There is no period in which an unverified requested tool is
installed: bootstrap installation still uses the applied, hash-verified manifest.

`.node-version`, `.nvmrc`, `.python-version`, custom JSON metadata and coordinated
native source locks are not independently updatable Dependabot manifests. Moving
interpreter discovery to Dependabot would require changing the development/runtime
architecture, rather than just configuring a package manager. Keep interpreter
and container versions separate where native wheels and Lambda require it.

## Review boundaries

New tooling and infrastructure coverage creates Dependabot PRs without expanding
Claude write permissions or the automatic merge allowlist. The consumer fixture
and example updates also require review. Existing application update, CI repair,
GitHub Merge Queue, deployment and Terraform-apply boundaries remain in effect.
