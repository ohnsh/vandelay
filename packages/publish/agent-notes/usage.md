# Publication workflow

- Date: 2026-11-17. Source baseline: `b9cc1657f716edc605262207cb87dd790e159762`
  plus the accompanying extraction from `@vandelay/web`.
- Status: implemented behavior; live R2 deployment has not been exercised.
- Evidence: `src/{prepare,media,store,reader,upload}.ts`, `test/`.
- Limits: FFmpeg and synthetic fragmented HEVC/H.264 fixtures on macOS; revalidate
  codec/browser behavior and hosted caching when deploying.

From `packages/publish/`:

```sh
bun run build --repo ../../data --commit HEAD
bun run build --repo ../../data --commit HEAD --stride 2
bun run build --repo ../../data --commit HEAD --media none
```

Defaults: `--out dist`, `--cache .cache/media`, `--stride 1`, `--media all`,
`--media-archive ~/.local/share/vandelay/media`. Stride is 1, 2, 3, or 4.
`--day YYYY-MM-DD` is repeatable; it selects the complete contents of this
publication, not an incremental patch to the previous publication.
`--signature` requires Git signature verification. `--media-urls FILE` supplies
external VOD links keyed by source SHA-256; remote bytes are not verified.

The commit is resolved once. Working-tree data is not a publication input.
Verification failure leaves the previous discovery pointer intact. Generated
objects are append-only; failed generations can leave unreferenced objects.
The CLI excludes simultaneous builds in its working directory. Use a single build
writer for a given output/cache pair.

## R2 upload

Use an existing R2 bucket with a production custom domain. The upload endpoint is
the S3 API hostname, not the custom delivery hostname:

```sh
export S3_ENDPOINT=https://ACCOUNT_ID.r2.cloudflarestorage.com
export S3_BUCKET=vandelay-publications
export S3_ACCESS_KEY_ID=...
export S3_SECRET_ACCESS_KEY=...
bun run upload --from dist
```

The uploader verifies the selected local generation and its dependencies, uploads
only missing immutable objects, then conditionally updates `current.json`.
It records content types, cache headers, and SHA-256 object metadata. Conflicting
immutable objects and competing pointer updates fail explicitly. Rerunning resumes
after interrupted uploads. No bucket listing, deletion, or Worker deployment occurs.
Uploads use single-part PUTs; generated chunks are bounded to 240 frames.

Configure custom-domain Cache Rules to cache immutable JSON as well as media and
respect origin cache headers. `current.json` must revalidate; do not apply a
long-lived override to it. Immutable objects have a one-year immutable TTL.
Use CORS GET/HEAD rules if browser code needs cross-origin fetches; server-side
Days reads do not require CORS. Verify byte-range playback on the actual hostname.
Do not use `r2.dev` for production delivery.

Updating the publication does not itself purge Days' HTML cache. Once Days is
integrated, its publication job should invoke Days' existing per-day invalidation
for changed/removed dates after the pointer update succeeds. The uploader does not
yet have a Days-specific authentication or webhook configuration.

## Consumer API

```ts
import { httpReader, openPublication } from '@vandelay/publish/reader'

const publication = await openPublication(httpReader('https://archive.example.com/'))
const day = await publication.day('2026-11-17')
```

`undefined` means the manifest does not contain the date. Fetch, integrity, or
schema failures throw; callers should distinguish failure from an empty day.
The reader verifies manifest/day bytes against hashes and sizes, then validates
their references. Media is fetched directly by browsers; the reader does not
download or hash every video.

Pass a saved `current.json` object as the second `openPublication` argument to pin
a generation. For local files, supply `async path => readFile(safePath(root, path))`.
All object paths are relative to the publication root. Consumers choose their own
record routes and media origin.

Checks: `bun run check`, `bun run test`. Media tests require FFmpeg with libx264,
libx265, and WebP support. No credentials or network services are required by tests.
