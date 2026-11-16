# Vandelay workspace

- Updated: 2026-11-15. Source commit: `50bf174674c79e1075ebf71334812d1a26abb452` plus workspace migration.
- Status: observation; maintained workspace usage reference.
- Evidence: [workspace scripts](../package.json), [ddb CLI](../packages/ddb/src/cli.ts),
  [web scripts](../packages/web/scripts/), and [AutoRedact CLI](../packages/autoredact/src/cli.ts).
- Limits: commands run from the workspace root. Revisit when package scripts,
  archive defaults, or publication/review integration changes.

## Setup and commands

Requires Bun 1.3+. Install dependencies from the workspace root:

```sh
bun install --frozen-lockfile
```

The workspace contains `@vandelay/ddb` (collection and archive CLI),
`@vandelay/web` (static publication), and `@vandelay/autoredact` (scanning and review).
Cross-package imports use package exports and `workspace:*` dependencies.

```sh
bun run ddb --help
bun run autoredact --help
bun run check
bun run test
```

The last two commands run each package's checks/tests in its own directory.
Package-specific prerequisites and optional integration checks are documented in
the [ddb](../packages/ddb/agent-notes/usage.md),
[web](../packages/web/agent-notes/usage.md), and
[AutoRedact](../packages/autoredact/agent-notes/usage.md) usage notes.

## Collect and verify

Initialize a dedicated data repository (default `./data`, ignored by this source
repository), then collect a source:

```sh
bun run ddb init
bun run ddb collect daycap \
  --day 2026-11-14 --timezone America/Chicago --instance desktop \
  --daycap-export /path/to/daycap-export \
  --media-archive ~/.local/share/vandelay/media
bun run ddb verify 2026-11-14
```

Commit the verified collection in the data repository before building the site.
See [ddb usage](../packages/ddb/agent-notes/usage.md) for other collectors, Git
author/signing configuration, commit commands, timestamp proofs, and archive
backup requirements. The [record envelope](../packages/ddb/agent-notes/record-envelope.md)
defines the shared record semantics.

## Scan and review

```sh
bun run ddb scan data/2026/11/14/daycap/desktop \
  --media-archive ~/.local/share/vandelay/media --report /path/to/scan.json
bun run ddb review /path/to/scan.json
bun run ddb apply-review /path/to/scan.json \
  --review /path/to/scan.review.json --out /path/to/publication.json
```

Use an existing report directory outside the scan inputs. These commands retain
AutoRedact's exit statuses: 0 for complete/clear, 1 for findings or pending review,
and 2 for incomplete scans or invocation errors.

**Review manifests are decisions, not edited media; the static web build does not
yet consume them.** Scanning and review do not automatically withhold content from
the build. See [AutoRedact usage](../packages/autoredact/agent-notes/usage.md) for
scope, coverage, and decision semantics.

## Build and publish

The web package builds calendar views, daily timelines, capture galleries,
sample timelapses, and Pagefind search from a pinned data-repository commit:

```sh
bun run --cwd packages/web build --commit HEAD
bun run --cwd packages/web preview --port 4324
```

`HEAD` refers to the data repository and is resolved once; working-tree changes
are not publication inputs. Open **http://localhost:4324**. The static site is
written to `packages/web/dist/`; building does not deploy it.

Media preparation uses the external archive and FFmpeg; use `--media none` for a
text-only build. Publish the complete output directory as one artifact. See
[web usage](../packages/web/agent-notes/usage.md) for selection, media URLs,
subpath hosting, verification, and provenance.
