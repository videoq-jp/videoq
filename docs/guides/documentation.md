---
title: Update the documentation
description: Write actionable documentation and preview the English and Japanese sites locally.
---

# Update the documentation

English is the default language. English pages live in the repository's `docs/` directory; Japanese translations live in `apps/docs/i18n/ja/docusaurus-plugin-content-docs/current/`. Docusaurus publishes only the pages explicitly listed in `apps/docs/public-content.json`.

Use English for the repository's default Markdown documentation, including READMEs, contributor guides, operational runbooks, and the pull request template. Keep Japanese site translations in `apps/docs/i18n/ja/`. Preserve original copyright and license notices, and retain non-English text when it is required by a quoted identifier or a localization example. Write the surrounding explanation in English.

## Start and preview

```bash
npm ci
npm run dev:docs
```

Open `http://localhost:3001` for English. The API and database are not required. The development server runs one language at a time. Stop it before starting Japanese:

```bash
npm run dev:docs -- --locale ja
# http://localhost:3001/ja/
```

To check the language switcher and full-text search, stop the development server and build both languages:

```bash
npm run build:docs
npm run preview:docs
```

English is served at `/` and Japanese at `/ja/`. Use the language menu in the header to switch between translations of the current page.

## Where content belongs

| Reader's goal | Directory within each language's content root |
|---|---|
| Run the app or make a first change | `getting-started/` |
| Understand terms and mechanisms | `concepts/` |
| Complete a specific task | `guides/` |
| Explore design details | `architecture/`, `database/`, `design/`, `requirements/` |
| Look up terminology | `reference/` |

When adding a page, create the English page and its Japanese counterpart at the same relative path. Keep document IDs and slugs aligned so switching languages stays on the same page. Review both versions for public release, add the exact relative file path to `apps/docs/public-content.json`, register it in reading order in `apps/docs/sidebars.ts`, and link to it from related pages.

Navigation and sidebar translations are in the JSON files under `apps/docs/i18n/ja/`. Update the English labels in the configuration and their Japanese translations together. Keep both language versions current when changing instructions.

## Review information before publishing

The site and GitHub repository are public. Keep development explanations and generic procedures here; store confidential operational records in an access-controlled system outside this repository. A page excluded from the site is still visible in the repository.

Production runbooks in `docs/operations/` are intentionally left out of `public-content.json`, so they have no Japanese translation or sidebar entry. Link to them with GitHub URLs from published pages.

Use generic dashboard links and example values. Do not include real account IDs, contact email addresses, credentials, signed URLs, customer data, or production logs. Review images and downloadable files too; files under `apps/docs/static/` require a separate entry in `public-content.json`'s `staticAssets` list.

The build scans both source languages and all generated files, including search indexes and JavaScript, for common sensitive-data patterns. It also checks approved page routes and translation completeness. A passing check does not replace a content review. Removing a published value does not remove it from Git history or copies already obtained by others.

## Write for first-time readers

- Begin with what the reader will be able to do and any prerequisites.
- State where to run commands and what successful output looks like.
- Explain new abbreviations on first use. Preserve code identifiers and explain their meaning in the page's language.
- Keep each diagram focused on one question. Explain where to start reading and what matters.
- Distinguish current behavior, verification records, and future plans.
- End with links to the next task or relevant reference material.

Follow the pattern “short explanation → small example → steps to try → next page,” as in Hono's documentation. Make the content actionable, not just visually similar. [Reference: Hono Getting Started](https://hono.dev/docs/getting-started/basic)

## Links and diagrams

Use relative `.md` links between documents and GitHub links for source code outside the site. Public pages use `.md`. Supporting React components in `.mdx` requires reviewing the publication policy and embedded content; the current manifest rejects `.mdx` files.

Write Mermaid diagrams in fenced code blocks. A successful build checks document links but does not guarantee that diagrams render correctly, so inspect them in a browser too.

The build checks document links and heading anchors for both languages. See [apps/docs/README.md](https://github.com/videoq-jp/videoq/blob/main/apps/docs/README.md) for configuration details.
