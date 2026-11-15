# did web

- Updated: 2026-11-15. Source commit: `f6704667bf9b32d4de7ce4e52cf1a76320985a8b`.
- Status: observation; publication usage and implementation constraints.
- Evidence: [`web/package.json`](../web/package.json),
  [`web/scripts/`](../web/scripts/), [`web/src/lib/`](../web/src/lib/),
  and [`web/test/`](../web/test/).
- Limits: commands below run from `web/` unless stated otherwise; code and output
  paths in this note are relative to that package unless prefixed with `web/`.
  Example commit IDs require the original local data repository; substitute a
  commit from your archive. Revisit on build, projection, or media-recipe changes.

Static publication of a pinned did archive snapshot. Astro renders the calendar,
day tracks and capture pages; React enhances timelapse playback; Pagefind searches
activity summaries, detail passages, observations, reports and app/window events.
Visitors need only a static HTTP host.

## Build the current archive

Install from the workspace root:

```sh
bun install --frozen-lockfile
```

Then, from `web/`:

```sh
bun run build --commit ddc9dd39ced26
bun run preview --port 4324
```

Open **http://localhost:4324**. Output is `web/dist/`. Building does not deploy it.
Publish the entire directory as one artifact, including `pagefind/`, `media/` and
`publication.json`. The site needs HTTP; Pagefind and module loading do not work
reliably from `file://`.

Requires Bun and an Astro-compatible Node installation. Media preparation also
requires FFmpeg/ffprobe with WebP and H.264 encoders. No live source applications,
databases, network media downloads, or model calls are needed.

### Options

```sh
# Text/metadata-only build; useful when media or FFmpeg is unavailable.
bun run build --commit ddc9dd39ced26 --media none

# Publish a selected day from another data repository.
bun run build --repo /path/to/archive --commit COMMIT \
  --day 2026-11-14 --media-archive /path/to/media

# Require Git signature verification using the archive's existing trust configuration.
bun run build --commit SIGNED_COMMIT --signature

# Optional published VOD recording links, keyed by original SHA-256.
bun run build --commit COMMIT --media-urls /path/to/media-urls.json
```

`--day` is repeatable. Defaults are `--repo ../data`, `--commit HEAD`,
`--media selected`, and `--media-archive ~/.local/share/did/media`. HEAD is resolved
once to a full commit ID before reading anything. The checked-out working files
are never publication inputs.

`--media-urls` is an object such as:

```json
{
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef": "https://media.example/recording.mp4"
}
```

These are configured external links, not claims that remote bytes were verified.
Recordings without configured URLs still show their timing, identity and byte size.

### Domain subpaths

```sh
DID_WEB_BASE=/did bun run build --commit ddc9dd39ced26
DID_WEB_BASE=/did bun run preview --port 4324
```

Visit `http://localhost:4324/did/`. Use the same base for build and preview.
All generated navigation, React media URLs and search results respect it.

### UI development

```sh
bun run snapshot --commit ddc9dd39ced26 --media none
bun run dev
```

`snapshot` prepares `.data/prepared.json`; restart dev after changing this input.
Use `build` + `preview` to exercise media and Pagefind: the finished publication,
including cached derivative copies and the search index, is assembled by `build`.

## Views

- **Calendar:** available days and source coverage.
- **Day:** chronological narrative cards, source/instance filtering, structured
  details, observations, ActivityWatch window/AFK tracks, VOD recordings, capture
  gaps and analysis records. Reports and unknown-time records have a day overview.
- **Capture pages:** 100 records per page, including metadata for captures without
  prepared images. Cited captures have stable source-qualified anchors.
- **Search:** passage-level results, shareable query/filter URLs, and date, source,
  instance, type, app and category filters.

All narrative content is static HTML. Details use native disclosures. Visiting a
record/detail fragment opens its containing disclosures and clears a conflicting
source filter. React is limited to the media player and its wall-clock/frame seek
controls.

Foreground app names come from retained Daycap capture application state when
the foreground remained stable across the capture. App badges are monogram
fallbacks: the inspected export has app identities but not the icon PNGs supplied
by Daycap's native host.

## Archive semantics

The build verifies each selected day through did's existing verifier, reads exact
Git blobs, then projects source-specific payloads:

| Source | Presentation treatment |
| --- | --- |
| Daycap | Sample envelopes, ordered details, exact revision-qualified citations, generation and continuation links |
| Dayflow | Source-asserted intervals, verbatim detail prose, batch-only attribution |
| ActivityWatch | Separate window and AFK event tracks |
| VOD | Recording intervals, object identities, optional external playback links |

Original time remains inspectable; day placement controls the visible time label.
DST scopes and calendar-associated reports retain did's existing semantics.
Overlapping source accounts remain separate; sampled bounds are not accumulated
as time worked.

Reference links require the exact requested revision. Evidence-only and unavailable
targets are displayed with their resolution status. Timelapse selection separately
resolves the **current archived capture rendition**, explicitly labelled as such.
It does not substitute those bytes into historical model-input provenance.

The projection suppresses withdrawn/superseded narrative and unavailable capture
media. It consumes the selected snapshot's recorded lifecycle state; it does not
infer withdrawal from absence or alter historical snapshots.

Source-generated text is rendered as text, including unstructured Dayflow details.
Search is built from the same projection, not scraped from the currently visible
React state. Raw evidence files and source databases are not copied into the site;
record provenance includes archive-relative evidence locators.

## Media derivatives

The default selection prepares:

- All current Daycap frames explicitly cited by activity cards.
- Up to 12 evenly distributed Dayflow screenshots within each card's day-clipped
  time interval. These are **contextual time selections**, not asserted model inputs
  or exact supporting citations. A card's generating batch can be later than the
  activity it summarizes.
- One available frame per capture source for browsing.

Selected source objects are constrained to the supplied archive root and verified
against their recorded SHA-256 and byte size. Frames are decoded by exact
presentation-order index. ffprobe checks the declared presentation-time mapping:
Daycap uses its rational selector; current Dayflow stores frame N at N seconds.
Missing objects remain visible as unavailable. Changed bytes or contradictory
frame mappings fail preparation.

Previews are WebP, at most 1280 pixels wide. Each activity's sample montage is an
H.264 MP4 with 0.5 seconds of presentation per retained frame. It letterboxes
different dimensions into 1280×720. The React playback map links each output
position to the archived capture and wall-clock timestamp; all transitions
explicitly skip unsampled time. This first prototype is a **sample timelapse**,
not a continuous reconstruction or a native-speed screen recording.

Derivatives are cached in `.cache/media/` by source identity, selector and
versioned transform recipe (including FFmpeg version). Cached output hashes are
checked before reuse; original selected objects are rehashed on each preparation.
Whole source videos, which can contain footage outside the selected day, are not
copied to the site.

The current prototype fully rebuilds HTML and Pagefind. Its media cache survives
rebuilds and is safe to delete.

## Provenance and publication

`publication.json` contains:

- Full input commit, selected day scopes and source manifest hashes.
- Input configuration digest, generator source/config/lockfile digest.
- Separate archive, signature and timestamp verification states.
- Derivative hashes, sizes, recipes and source frame selectors.
- An inventory of generated output files, excluding the manifest itself.

Archive inventory verification always runs. Signature verification is opt-in and
fails the build if Git cannot verify it. Timestamp verification is currently
reported as `not checked`. Source signatures authenticate archive bytes, not the
generated HTML.

Preparation writes its complete projection last. Builds finish HTML, media,
search and the publication manifest in a staging directory before replacing
`dist/`; a failed build leaves the previous `dist/` intact. Deploy by uploading the
completed artifact atomically rather than serving the local directory during its
two-rename replacement.

A `.data/build.lock` directory excludes concurrent preparation/build writers.
After a forcibly terminated process, remove this directory only after confirming
the build has stopped. `.data/`, `.cache/`, `.astro/` and `dist/` are ignored.

## Checks

```sh
bun run check
bun run test
bun x playwright install chromium
bun run test:browser
```

Unit/integration tests use synthetic records, a temporary Git repository and a
tiny generated video. They cover pinned reads despite dirty working files,
tampered inventories, citation revisions, DST clipping, calendar/unknown times,
withdrawn content, contextual attribution, frame/PTS agreement, cache corruption
and missing media.

Browser tests exercise the locally built publication, including the overlapping
Daycap/Dayflow day, deep links, search, native video decoding, React frame seeking,
mobile overflow and no-JavaScript narrative. They block external requests. Run
with `DID_WEB_BASE=/did` after a subpath build to check project hosting.
