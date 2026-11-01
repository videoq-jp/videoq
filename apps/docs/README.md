# VideoQ Docs

The documentation site uses Docusaurus 3. English is the default language at `/`; Japanese is available at `/ja/`. The header language menu switches to the same page in the other language.

## Start and build

Use the Node.js version in `.node-version` (the site requires 22.12 or later) and run these commands from the repository root:

```bash
npm ci
npm run dev:docs
# http://localhost:3001 (English)

# Stop the development server before switching to Japanese:
npm run dev:docs -- --locale ja
# http://localhost:3001/ja/

npm run typecheck --workspace @videoq/docs
npm run build:docs
npm run preview:docs
# http://localhost:3001 (English)
# http://localhost:3001/ja/ (Japanese)
```

The development server runs one language at a time. Use `build:docs` followed by `preview:docs` to verify the language switcher and full-text search across both builds.

The root npm overrides keep Docusaurus's transitive `serialize-javascript` at 7.1.4 or later
and SockJS's CommonJS-compatible `uuid` at 11.1.1 or later for their security fixes
([serializer advisory](https://github.com/yahoo/serialize-javascript/security/advisories/GHSA-qj8w-gfj5-8c6v),
[UUID advisory](https://github.com/uuidjs/uuid/security/advisories/GHSA-w5hq-g745-h8pq)).
Remove the overrides once upstream dependencies require patched versions; verify both
locale builds and the documentation dev server when changing them.
Use npm 11.20 or later (the repository pins its npm version in `package.json`) when updating these dependencies: older npm versions can ignore
overrides across workspace links. To use it without changing the global installation,
run `npm exec --yes --package=npm@11.20.0 -- npm update serialize-javascript uuid`.

`dev:docs` and `preview:docs` use the same port, so stop the running server before switching. The API, database, and Docker are not required.

## Edit documentation

| Content | Location |
|---|---|
| English pages (default) | `docs/**/*.md` |
| Japanese pages | `apps/docs/i18n/ja/docusaurus-plugin-content-docs/current/**/*.md` |
| English navigation and footer | `apps/docs/docusaurus.config.ts` |
| English sidebar categories | `apps/docs/sidebars.ts` |
| Japanese navigation and footer | `apps/docs/i18n/ja/docusaurus-theme-classic/*.json` |
| Japanese sidebar categories | `apps/docs/i18n/ja/docusaurus-plugin-content-docs/current.json` |

- Keep the same relative paths, document IDs, and slugs in both languages. Add each new page to both content roots and register it in `sidebars.ts` in reading order.
- Add a reviewed page's exact relative path to `public-content.json`. Only listed pages are built in either language; adding a file or sidebar item does not approve it for publication. Runbooks in `docs/operations/` are intentionally unlisted.
- Update both languages when instructions change. The prebuild check requires both files for each approved page; review their contents to keep translations complete and current.
- The sidebar groups pages into Get started, AI behavior, Core concepts, Development guides, Design reference, Operations, and the Glossary. Organize around reader goals as well as document types.
- Public pages use ordinary Markdown (`.md`). Supporting React components in `.mdx` requires reviewing the publication policy and embedded content; the current manifest rejects `.mdx` files.
- Use fenced `mermaid` blocks for diagrams, and translate their visible labels while preserving identifiers.
- Use relative `.md` links between documents so readers stay in their selected language.
- Link to files outside the site, such as `apps/` or `infra/`, using GitHub `blob/main/` or `tree/main/` URLs.
- The edit-page link targets the displayed language's source file.
- English and Japanese search indexes are generated at build time. No external search service or API key is needed.

CI detects changes to the documents and site configuration, then runs type checking, publication-policy tests, content checks, builds both languages, and validates links and anchors. Generated output is checked; only manually run CI saves it as the `documentation-build` artifact.

## Public information policy

This site and its GitHub repository are public. Existing development, design, and generic operational documentation is intentionally published. Excluding a page from the site does **not** make its repository source or Git history private. Keep confidential operational records in an access-controlled system outside this repository.

- Use generic service-dashboard links. Do not include real account IDs, personal/contact email addresses, credentials, signed URLs, customer data, or production logs. Use reserved example addresses such as `developer@example.com` when an example is necessary.
- Review both languages before adding exact file paths to `public-content.json`; wildcard entries are rejected. The current policy supports Markdown pages with their default routes (including README category indexes). A custom slug requires updating and reviewing the generated-route check.
- Review downloads separately. Every file under `static/` must be listed in `public-content.json`'s `staticAssets`; adding a document to the page list does not approve an attachment.
- `npm run check:content --workspace @videoq/docs` scans both source trees, including pages excluded from the site, and static assets. It requires both translations of each approved page.
- `npm run build:docs` runs the policy tests and source check, builds both languages, then scans all output files, including HTML, JavaScript, search indexes, and sitemaps. It rejects unapproved HTML routes and incomplete locale builds.
- `npm run deploy --workspace @videoq/docs` repeats the source and output checks before uploading. Rebuild after editing content; do not deploy old artifacts directly with Wrangler.

These checks detect common credential/account patterns, non-example email addresses, and remote PostgreSQL credentials; they are not a complete secret scanner or a substitute for reviewing the content and attachments. Diagnostics show only file locations and categories, never matched values. Removing published content cannot retract copies already downloaded, indexed, or preserved in Git history.

The language setup follows [Docusaurus internationalization](https://docusaurus.io/docs/i18n/tutorial).

## Production deployment

The site is hosted as static assets on Cloudflare Worker `videoq-docs`:

- English: <https://docs.videoq.jp/>
- Japanese: <https://docs.videoq.jp/ja/>

After documentation changes are merged into `main` and its push CI succeeds,
[GitHub Actions CD](../../.github/workflows/cd.yml) automatically rebuilds and publishes both languages.
It watches `docs/**`, `apps/docs/**` (including Japanese translations), the root `package.json`
and `package-lock.json`, the CI/CD workflows, and deployment policy scripts.
Changes are compared with the last successful CD run, so changes from cancelled CI runs are included.

The docs job uses the verified `main` commit and runs independently of API, Lambda, and database deployment.
It uses the existing `production-app` environment's `CLOUDFLARE_API_TOKEN` and the repository's
`CLOUDFLARE_ACCOUNT_ID` secret. Credentials are passed only to the upload step, after type checking
and building both languages. PRs and feature-branch pushes do not publish the site.
Manually running CD on `main` also republishes the docs, along with the other deployment targets,
and requires successful push CI for that commit.

To rebuild and publish both languages manually from the repository root:

```bash
npm ci
npx wrangler login
npm run deploy:docs
```

Wrangler requires access to the Cloudflare account containing `videoq-docs` and the `videoq.jp` zone. `apps/docs/wrangler.jsonc` fixes the Worker name, static asset directory, and custom domain. This manual command uploads the current working tree, including uncommitted documentation changes.

The custom domain `docs.videoq.jp` is declared in Wrangler configuration. Cloudflare creates its DNS record and manages the HTTPS certificate during deployment. Trailing slashes match Docusaurus URLs, and missing paths serve the generated 404 page. The `workers.dev` and preview URLs are disabled.

## Static hosting settings

| Setting | Value |
|---|---|
| Working directory | Repository root |
| Install | `npm ci --workspace @videoq/docs` |
| Build command | `npm run build:docs` |
| Publish directory | `apps/docs/build` |
| Node.js | 22.12 or later |

`DOCS_URL` sets the public origin and `DOCS_BASE_URL` sets its path at build time. Defaults are `https://docs.videoq.jp` and `/`. For another host, adjust these values before building; they do not provision a domain or hosting.

```bash
DOCS_URL=https://example.com DOCS_BASE_URL=/videoq/ npm run build:docs
```

Publish the entire `apps/docs/build` directory, including `ja/`. For subpath hosting, start and end `DOCS_BASE_URL` with `/`; the example serves English at `/videoq/` and Japanese at `/videoq/ja/`.

Blogging and documentation versioning are disabled.
