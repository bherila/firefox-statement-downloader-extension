# Working on this repository

A Firefox MV2 extension that bulk-downloads financial documents. Plain
JavaScript, no bundler, no runtime dependencies.

## Before anything else: the commit hook

`pnpm install` sets `core.hooksPath` to `scripts/githooks`, which installs a
pre-commit check. If you skipped install, or hooks are not firing:

```bash
git config core.hooksPath scripts/githooks
```

Verify it is active before committing:

```bash
git config core.hooksPath   # must print scripts/githooks
```

**Why this matters more than usual here.** Providers are calibrated against real
accounts, so real account numbers, plan identifiers and employer names end up in
front of you constantly and are trivially easy to paste into a test fixture. The
repository is public. Once such a value is pushed, rewriting history does not
reliably remove it — the objects stay reachable by hash — so the only real remedy
is deleting and recreating the repository. That has already happened once.

The hook blocks account-shaped identifiers, home directory paths, long numeric
ids in URLs, and session material. `.git/personal-data-denylist` optionally holds
literal values from your own accounts, one extended regex per line; it lives
inside `.git` so those literals are never committed to the tree they protect.

**Use synthetic fixtures.** `100000001`, `2000001`, `EXAMPLE EMPLOYER`. Never a
real value, even temporarily, even if you intend to scrub it before committing.

## Commands

```bash
pnpm install --frozen-lockfile
pnpm lint        # eslint
pnpm typecheck   # tsc over JSDoc-annotated JS
pnpm test        # node --test
pnpm build       # dist/firefox-statement-downloader-extension.zip
```

All four must pass before committing. Do not use `npm ci`.

## Architecture

`core/` is shared: normalized document metadata, provider-scoped storage,
download-history checks, retry and backoff, stop handling, and the Shadow DOM
launcher and drawer.

`providers/` holds one adapter per institution. Each owns its page detection,
discovery, download behaviour, and filenames. They deliberately do **not** share
a model — the institutions differ too much for that to be an abstraction rather
than a straitjacket.

New providers must satisfy the `FsdProvider` interface in `types/globals.d.ts`
and carry `/** @type {FsdProvider} */` above the object literal. Without that
annotation the registry is untyped and a provider missing a method its callers
invoke by name fails only at runtime, on a live financial site. This has happened;
the annotation is what makes `pnpm typecheck` catch it instead.

## Things that are true here and cost time to rediscover

**Prefer the site's own API to its DOM.** Both rewritten providers replaced DOM
scraping that silently returned a fraction of the data — one table capped at ten
rows with no pagination, another paginating in memory over a corpus it had
already fetched whole. A UI that looks complete is not evidence that it is.
Always reconcile what you collect against what the API reports.

**Anchor injected UI to headings, not to controls.** Launchers anchored beside
filter controls get discarded when the framework re-renders that subtree after
its data loads. Section headings are stable. Mounting also waits for the page to
settle first.

**Retention differs by document type**, and by institution, and it rolls. An
existing archive of old documents may hold things no longer obtainable. Merges
into a user's archive must be additive; never overwrite or dedupe against it.

**Do not probe rate limits or evade bot detection.** These are real accounts.
Throttle conservatively with jitter, back off on refusal, and stop rather than
retry into a soft block. If a site rejects the extension's traffic, that is an
answer, not an obstacle to route around.

## Provider notes

`docs/netbenefits-calibration.md` records the NetBenefits contract, which was
expensive to obtain and cannot be re-derived by driving a browser — that site
blocks automation.
