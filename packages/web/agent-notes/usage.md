# Vandelay web

- Updated: 2026-11-17; source baseline: `b9cc1657f716edc605262207cb87dd790e159762`
  plus the accompanying publishing-package extraction.
- Status: implemented consumer behavior.
- Evidence: `scripts/{prepare,build}.ts`, `src/lib/presentation.ts`, `test/`.
- Limits: static rebuilds; deployed R2/CDN behavior is not established by local tests.

The standalone Astro site consumes the formal
[`@vandelay/publish` projection](../../publish/agent-notes/contract.md).
It does not read Git repositories, source evidence, or media archives, and does not
run FFmpeg. Preparation reads a pinned publication once and writes
`.data/prepared.json`; Astro builds the calendar, narrative, capture pages, and React
players from that projection. Pagefind indexes the same narrative/details.

## Build

From `packages/web/`, after `bun install` at the workspace root:

```sh
# Build directly from a hosted publication. Videos remain on the publication host.
bun run build --publication https://archive.example.com/

# Consume local JSON, but keep deployed media outside Worker Static Assets.
bun run build --publication ../publish/dist \
  --asset-base https://archive.example.com/

# Self-contained local preview, explicitly copying verified assets.
bun run build --publication ../publish/dist --copy-media
bun run preview --port 4324
```

`--publication` defaults to `../publish/dist`. `--day YYYY-MM-DD` is repeatable.
`--pin /path/to/current.json` pins a previously saved discovery pointer.
HTTP publications default to their own origin for assets. Local publications with
media require either `--asset-base` or `--copy-media`. Hosted media is not downloaded
or copied into the web deployment. Use `--copy-media` for offline/local demonstrations,
not a growing production media archive.

The publisher's build command now owns `--repo`, `--commit`, `--media-archive`,
`--media`, `--stride`, `--signature`, and `--media-urls`; see its usage guide.

```sh
VANDELAY_WEB_BASE=/vandelay bun run build --publication ../publish/dist --copy-media
VANDELAY_WEB_BASE=/vandelay bun run preview --port 4324
```

Use the same base for build/preview. Consumer routes and local media use that base;
absolute hosted media URLs remain unchanged.

UI development:

```sh
bun run snapshot --publication https://archive.example.com/
bun run dev
```

Restart dev after changing `.data/prepared.json`. Use a finished build to exercise
Pagefind. No source applications, media encoders, or database access are needed.

## Views and semantics

- Calendar: available days and source coverage.
- Day: source filtering, activity cards, details, observations, window/AFK tracks,
  recordings, gaps, analysis, and day-level screen timelapses.
- Capture pages: 100 captures per page; missing/sampled-out metadata stays visible.
- Search: passage-level summaries/details with source, date, type, app filters.

Static narrative is usable without JavaScript. React enhances shared-chunk
timelapses with capture seeking and playback speed. Both day and activity players
reference the same video objects. A chunk switch may buffer; this is progressive
MP4 playback, not gapless adaptive streaming. Playback time is not wall time.

Activities use contextual captures within their bounds, while citation links
remain pinned to exact source revisions. Current frames never substitute silently
for historical model inputs. Overlapping accounts are not summed as time worked.

Routes, capture pagination, deep links, and the asset origin are supplied by
`src/lib/presentation.ts`; published JSON does not contain website URLs. Missing
dates and failed publication reads remain distinct.

## Output and checks

`dist/` contains HTML, client JS/CSS, Pagefind, and `publication.json`, plus media
only when explicitly requested. The site manifest pins the source publication
manifest and inventories generated files. A failed build leaves the previous
`dist/` intact. `.data/build.lock` excludes concurrent writers.

```sh
bun run check
bun run test
bun run test:browser
```

The build integration test produces synthetic publication artifacts, verifies
subpath and hosted-media builds, and exercises cross-chunk browser playback when
Playwright Chromium is installed (`bunx playwright install chromium`).
`test:browser` exercises the currently built site and expects a populated archive
with Daycap citations and multiple sources.
