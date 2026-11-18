# Publishing projection v1

- Date: 2026-11-17; source baseline: `b9cc1657f716edc605262207cb87dd790e159762`
  plus the accompanying `@vandelay/publish` implementation.
- Status: accepted architecture, initial implemented wire contract.
- Evidence: `src/model.ts`, `src/validate.ts`, `src/reader.ts`, `src/store.ts`.
- Limits: v1 is the first consumer contract. Breaking changes require new schema
  identifiers; source-specific projection changes also change the generator digest.

## Objects and identity

All JSON is UTF-8, canonically key-sorted, with a terminating newline. Hashes are
lowercase SHA-256 over exact bytes. Optional properties are omitted, not `null`.
Paths are relative to the publication root, with no leading slash, `..`, query,
fragment, or URI scheme. Consumers resolve these against a local root or HTTP base.

| Object | Schema | Address |
| --- | --- | --- |
| Discovery pointer | `vandelay.publish.current/v1` | `current.json` |
| Publication manifest | `vandelay.publish/v1` | `publications/<sha256>/manifest.json` |
| Day projection | `vandelay.publish.day/v1` | `days/YYYY-MM-DD/<sha256>.json` |
| Daily preview | `vandelay.publish.preview/v1` | `previews/YYYY-MM-DD/<sha256>.json` |
| Playback manifest | `vandelay.publish.playback/v1` | `playback/<sha256>.json` |
| Video or poster | MP4 / WebP | `media/<sha256>.mp4` or `.webp` |

`ObjectRef` is `{ path, sha256, bytes }`. Discovery contains `schema` and a
`manifest: ObjectRef`. Only discovery is mutable. Its manifest pointer is updated
after every referenced object exists. Stale discovery remains a coherent older
generation; clients resolve it once per operation.

Manifest fields:

- `commit`: full source archive commit.
- `generator`, `generatorDigest`: publisher name/version and digest of its source
  files plus the workspace lockfile.
- `configuration`: `media` (`all` or `none`) and `captureStride` (1–4).
- `inputDigest`: digest of pinned input selection and configuration.
- `verification`: archive, signature, and timestamp verification states.
- `days`: sorted `{ scope, object: ObjectRef, preview?: ObjectRef }` entries. Scope contains `day`,
  `timezone`, `start`, and `end`, preserving the archive's calendar/DST semantics.

Metadata-only changes reuse identical day/media objects. Different publication
versions can retain different renditions of a frame; deduplication is by exact
object content, not a promise that all historical encodings are identical.
Objects reachable from retained manifests must not be garbage-collected.

## Lightweight consumers

New generations include `preview` for every day, even if both preview lists are
empty. Older v1 manifests can omit it. The preview repeats `scope`; `highlights`
contains up to three timestamped active activity entries in day placement order
(first, middle, last when there are more than three). Each exposes `anchor`, `at`
(day placement start/instant), `title` and `summary` (up to 120 and 240 Unicode
code points respectively). These are excerpts, not generated summaries.

Each preview `timelapses` item describes one day playlist: `source`, optional
`stream`, `label`, optional `poster` (existing WebP path), and `playback: ObjectRef`.
The referenced JSON contains `schema` and ordered `ranges` of `{ url, start, end }`.
`url` is an MP4 path relative to the **publication root**, not the JSON file.
`[start, end)` is in media seconds. Adjacent captures in the same file coalesce;
holes, repeats and chunk switches retain their playlist order. Frame identities,
exact frame inspection and activity-specific clips remain in the full day projection.
Playback maps may include `clock`: ordered `{elapsed, at}` minute changes, where
`elapsed` is cumulative montage seconds and `at` is the observed capture timestamp.
Display the most recent marker without interpolating wall time. Older maps omit it.

## Per-day projection

`PublishedDay` in `src/model.ts` is the complete typed field contract:

- `scope`, `sources`: calendar bounds and source-qualified manifest provenance,
  record counts, and coverage limitations.
- `entries`: narrative tracks, source IDs, status, original time and day placement,
  details, citations, categories, apps, provenance, and optional activity playlist.
- `frames`: capture identities, wall timestamps, original bounds, dispositions,
  source hashes/selectors, optional browsing poster, and optional playback location.
- `timelapses`: day playlists separated by source instance and logical stream.
- `assets`: sorted inventory of this day's referenced assets. Each extends
  `ObjectRef` with `mediaType`, transformation `recipe`, and source hash/frame/PTS
  `inputs`. Inventory lives here rather than in the discovery manifest so single-day
  readers do not load the entire archive's asset catalog.
  Input mappings include `outputFrame` (zero-based) so byte-identical assets can
  retain provenance from more than one source object.

Frame keys are JSON-encoded `[source-slot, record-id]` pairs. `anchor` values are
stable opaque identifiers, not application routes. Entry IDs are qualified by
`source`; links use identity plus optional revision. A link's `target` exists only
when the exact requested revision is included. Evidence-only/unavailable resolution
does not silently become a link to a different revision.

Published media metadata omits the local archive `location`. There are no source
database paths, original evidence payloads, or consumer `href` fields.
Source-manifest/evidence locators are provenance identifiers, not publicly served
raw-evidence URLs.

## Shared playback

A playlist (`Clip`) contains `label`, `selection`, and ordered `frameKeys`.
`selection` is `day` or `activity-time-range`. Each playable frame has:

```json
{
  "playback": {
    "asset": "media/<sha256>.mp4",
    "offset": 0.25,
    "duration": 0.25
  }
}
```

Offsets/durations are seconds in the derivative, independent of wall time and
source sample duration. Consumers combine adjacent ranges in the same asset for
ordinary uninterrupted playback, seek over holes, and switch assets at boundaries.
Playlists do not require separately encoded activity/day videos. Playback across
chunk boundaries may buffer; v1 is progressive MP4, not HLS or MSE.

The default retains every available current capture. Stride is applied to each
day/source/stream's chronological capture list: keep indices 0, N, 2N, etc. Captures
omitted by stride retain metadata and an explicit status. Missing media also retains
metadata; corrupt media or contradictory index/PTS selectors fail generation.

Retained source frames are grouped by source object and presentation-order index,
then chunked at 240 frames maximum. Each input frame is encoded once per publication.
Chunks are H.264/yuv420p faststart MP4, no B frames, maximum GOP 16, 1280×720
letterboxed, four captures per playback second. This implementation transcodes
to obtain consistent browser decoding and timestamps. It does not claim lossless
remuxing. Browsing posters use one WebP per source object, rather than a second
complete sequence of images.

Day playlists include all retained playable captures for their source/stream.
Activity playlists include all retained captures of the same source inside the
activity's day-clipped bounds (half-open for intervals, inclusive terminal request
for sampled bounds). `entry.frameKeys` retain the original citation/context
selection; an activity playlist is a contextual time selection and does not create
additional model-input citations. Withheld entries have no playlist.

Every transition can skip unsampled wall time. Neither constant playback holds,
sample envelopes, nor source sample durations establish continuous screen coverage
or time worked.
