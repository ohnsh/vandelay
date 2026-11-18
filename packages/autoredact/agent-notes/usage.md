# AutoRedact

- Updated: 2026-11-15. Status: observation; imported scanning/review usage.
- Source: AutoRedact `c487f4c09740b954ad53d289f305401955b9a943`, imported
  into Vandelay after `50bf174674c79e1075ebf71334812d1a26abb452`.
- Evidence: [`src/`](../src/), [`test/`](../test/), and
  [`package scripts`](../package.json).
- Limits: commands run from `packages/autoredact/` unless stated otherwise.
  Coverage depends on the configured rules and local media tools.

Local, on-demand pre-publication scanning of text records, screenshots, and video
frames. This TypeScript prototype focuses on **critical secrets**: `.env` files,
credentials in terminals, and revealed tokens in dashboard-style interfaces.
It is useful with Vandelay's collected Daycap and Dayflow records and media.

A completed scan with no findings is **silent and exits 0**. Findings exit 1.
Incomplete scans or invalid invocations exit 2, even if findings also exist.
Scanning never modifies inputs. Review can plan masks, and `render-review` or the
Vandelay publisher can render approved derivatives.

## Review in the browser

### Selective masking

New scans include every decoded frame and fingerprinted OCR regions. In review,
**Pending** shows findings and edited frames needing approval; **All** also exposes
unflagged frames. Old reports still support decisions; rescan them to enable masking.

Click an OCR region to create an anchored opaque mask, or choose **Add free mask**.
Drag to move, drag its corner to resize, or edit normalized coordinates numerically.
For an anchored mask, optionally enable **Follow matching OCR in this source** and
choose an inclusive first/last frame range. Exact case-sensitive NFC/whitespace-normalized
matches receive the same relative geometry. A changed OCR string or line segmentation
does not match. Physical aliases of identical media share masks.

**Save masks** persists the plan and invalidates approvals on affected frames.
Inspect propagated frames and choose **Approve masked frame**. Following masks link
back to their origin for editing/removal. Unsaved edits must be saved or discarded
before changing frames or deciding. Original media stays intact.

Mask-bearing reviews and exported manifests use **v2**, so consumers that only know
v1 reject them rather than ignoring the masks. Original masked files remain withheld;
approval applies to their derivative. OCR fingerprints and review files stay private.

Render lossless replacement frames and their source-to-output mapping:

```sh
bun src/cli.ts render-review report.json --review report.review.json --out ./new-rendition
```

The output directory must not exist. `manifest.json` binds source hashes/frame indexes/
presentation times to masked PNG hashes. Only approved masked frames are rendered;
this directory is not a full publication. Complete scan/review is required.

Build a reviewed Vandelay publication (from the workspace root):

```sh
bun packages/publish/src/cli.ts build \
  --repo ./data --commit HEAD --day 2026-11-14 \
  --media-archive ~/.local/share/vandelay/media \
  --redaction-report /absolute/report.json \
  --redaction-review /absolute/report.review.json \
  --out ./reviewed-publication
```

Scan the selected bundle directories, including evidence and manifests, before
reviewing. Publication verifies exact pinned text/media inputs; pending reviews,
incomplete scans, unscanned selected inputs and withheld text block the build.
Withheld frames are omitted from playback. Masks apply to both posters and shared
video chunks before resizing/encoding. `--media-urls` cannot accompany reviewed builds.
Text replacement is not implemented; pixel masking never approves associated text.

```sh
bun src/cli.ts review reports/report-dayflow-2026-11-07.json
```

Open **http://127.0.0.1:4317**. The React app is built automatically and served
locally by Bun, with no remote assets or uploads. No additional frontend server
is needed. Override the port with `--port`, and the review path with `--state`.

The review queue groups all findings on the same frame into one item, and text
findings at the same source pointer into one item. Overlapping boxes from the same
rule are combined **for display only**; switch on **Raw detections** or expand
**Source & original detections** to inspect the original findings. Grouping does
not remove or rewrite anything in the report.

- Inspect full-resolution frames with bounding boxes, fit/zoom controls, and
  independently hash-verified source bytes.
- Where available, capture times are recovered from verified Vandelay records and
  displayed in your browser's local timezone.
- Mark **Confirmed · withhold** or **False positive · publish**. A decision covers
  every original finding on that frame/text item.
- Add an optional note, saved when you choose a decision. Choose the decision
  again to update its note.
- Filter pending/all/withhold/publish items, search by rule or source, and optionally
  advance to the next unreviewed item.
- Use **C** to withhold, **F** to publish, **U** to reset, and **J/K** or arrow keys
  to navigate. Undo restores the previous decision.

Exact video frames are decoded by index, not approximated using seeking timestamps.
Missing or changed sources are shown as load errors rather than substituted content.
Viewing existing reports does not require Vision or Swift; image/video preview
requires FFmpeg.

### Immutable reports, separate reviews

The scan report stays untouched. By default, decisions are saved in a sibling:

```text
report-dayflow-2026-11-07.json          original scan, read-only
report-dayflow-2026-11-07.review.json   mutable review state
```

The `autoredact.review/v1` file binds to the SHA-256 of the **exact report bytes**,
and records a revision plus a decision/note/time for each reviewed group. Group
IDs are deterministic hashes of source + frame index or text pointer. Reformatting
or changing the report invalidates that binding; reviews cannot silently transfer
to another scan.

Each decision is persisted with an atomic replacement and private file permissions.
Concurrent edits use revision checks; refresh the review if another session has
changed it. A brief `.lock` file protects writes between server processes. If the
process is forcibly killed during a save, remove the stale `.review.json.lock`
only after confirming no review server is writing.

The review file contains no copied frame pixels or source text. It still contains
your notes and should remain private. **Review file ↓** downloads a standalone copy,
including an empty review before the first decision.

### Publication decision manifest

**Export manifest** downloads `autoredact.publication/v1`. The same operation is
available without the web app:

```sh
bun src/cli.ts apply-review reports/report-dayflow-2026-11-07.json \
  --review reports/report-dayflow-2026-11-07.review.json \
  --out reports/publication-dayflow-2026-11-07.json
```

The manifest includes the exact report/review hashes, review revision, all original
input hashes and sizes, group decisions with their original finding IDs, and scan
issues. It can be exported before review is complete; unresolved items remain
explicitly `unreviewed`.

- `complete`: every flagged group has a decision and the scan was complete.
- `pending-review`: at least one group remains unreviewed.
- `incomplete-scan`: the original scan was incomplete or reported coverage issues.

“Complete” does **not** mean “publish everything”: withheld items stay withheld.
The CLI exits 0 for complete review, 1 for pending review, and 2 for incomplete scans
or errors. It exclusively creates the output and never overwrites an existing file.

Group decisions describe individual flagged frames/text items. Input decisions
describe whether a **whole original file** can be published unchanged: any withheld
group withholds its containing file, and unreviewed groups prevent that file from
being marked publish. An incomplete scan prevents otherwise eligible inputs from
being marked publish. Inputs without findings are eligible only under the scan's
declared scope and completion status.

A future publishing/redaction step can use frame decisions to create derivatives.
`render-review` produces approved frame derivatives; the publisher assembles reviewed
containers. Text replacements and uploads are not AutoRedact operations. Consumers
must check input hashes and understand the manifest version before applying decisions.

## Run

Requires Bun 1.3+. Media scanning additionally requires macOS, Xcode command-line
tools (`swiftc`), FFmpeg, and ffprobe. Text-only scanning does not require those tools.

Install dependencies with `bun install --frozen-lockfile` from the workspace root
(see [workspace usage](../../../agent-notes/usage.md)), then run the following
commands from `packages/autoredact/`.

```sh
# Ordinary files or directories; all JSON string fields and keys are scanned.
bun run autoredact scan ./publication

# A collected Vandelay source bundle or day directory, plus its external media archive.
bun run autoredact scan ../../data/2026/11/14/dayflow/desktop \
  --media-archive ~/.local/share/vandelay/media \
  --report ~/scan-reports/dayflow-2026-11-14.json

# Machine-readable output, including the no-findings case.
bun run autoredact scan ./records.jsonl ./screenshots --json
```

The report parent directory must exist. Report files are created exclusively with
mode `0600`, must live outside scanned directories, and are never overwritten.
To get literally silent shell output, use `bun src/cli.ts scan …`; `bun run` may
print its own script command.

Directory inputs are recursively inventoried, including dotfiles except `.git`.
Unsupported files, symlinks, malformed JSON, missing media, and failed OCR/decode
operations make a scan incomplete rather than disappearing from coverage. Point
the scanner at a publication selection, not an entire application or Git repository.

## What is scanned

- Plain text (`.txt`, `.md`, `.env`, `.log`, `.csv`, `.sha256`).
- JSON / JSONL: string values, property names, and key/value assignments; numeric
  fields are also considered in assignment context. Reports retain JSON Pointers
  and JSONL line numbers, not matched content.
- Images (`.png`, `.jpg`, `.jpeg`, `.webp`, `.heic`, `.tiff`, decoder permitting).
- Videos (`.mp4`, `.mov`, `.mkv`): **every decoded frame** of the first video stream,
  in presentation order, with actual ffprobe presentation timestamps.
- Extensionless media reached through Vandelay archive references.

For Vandelay, pass the collected **directory**, not just a day/source manifest. This
includes evidence JSON as well as normalized records. Archive-relative references
are constrained to the supplied archive root and verified against hash and size.
Remote objects and unavailable references are reported as incomplete.

The entire referenced media object is scanned, including frames outside the
selected day's record timestamps. Dayflow's `frame_index` is interpreted according
to its stored-video convention (frame N at N seconds); Daycap selectors retain
their explicit frame index and presentation time. Frame-reference disagreements
with decoded media are reported as incomplete.

This does not verify Git signatures, bundle-manifest consistency, or that your
selection contains everything you intend to publish. Run `ddb verify` separately.
Native Daycap export directories can be scanned as ordinary files, but this
prototype's semantic frame/record adapter is for Vandelay, not native Daycap manifests.
It does not read Dayflow's live SQLite database; collect it with `ddb` first.

## Secret detection

`rules/secrets.v1.json` codifies the core rules derived from Daycap:

- Known credential prefixes and JWT-like tokens.
- Bearer/Basic authorization.
- Password, secret, token, API-key, and private-key assignments.
- Credential URLs and sensitive query parameters.
- Private-key block markers and one-time/recovery-code context.

Recognizable credentials are marked `high`; broader contextual rules are marked
`review`. Both produce exit 1. These labels are rule categories, not calibrated
probabilities or confirmation that a credential is live.

OCR uses local Apple Vision, accurate recognition, language correction disabled.
It scans the full image, with no quadrant assumptions, temporal sampling, or
approximate image-change skipping. Adjacent dashboard-style labels and long
token-shaped values produce a `credential-field` finding. A small, explicit
lookalike normalization handles OCR confusing Latin UI labels with Cyrillic letters.
This is layout/text recognition, not a Cloudflare- or Vercel-specific classifier.

There is no network inference, credential validation, PII model, face detection,
or YOLO runtime in this package.

## Synchronized records and frames

`vandelay.record/v1` records supply automatic frame links. For arbitrary JSONL records
or elements of a top-level JSON array, supply a JSON Pointer mapping:

```json
{
  "idPointer": "/id",
  "wallTimePointer": "/capturedAt",
  "assetPointer": "/video",
  "framePointer": "/frameIndex",
  "secondsPointer": "/presentationSeconds"
}
```

```sh
bun run autoredact scan ./export/records.jsonl \
  --mapping ./mapping.json --report ./scan.json
```

All mapping fields are optional. Asset paths are relative to the records file and
must resolve inside its directory. A configured asset field must exist on each
record. Frame indexes are zero-based integers; seconds are media presentation
seconds. Wall timestamps are ISO date strings preserved for review, **not** assumed
to equal video time. A frame reference takes precedence over media-time proximity
(±0.5 seconds). If both frame index and presentation time are present, they must
agree with the decoded frame. Image-only asset references can link without a time.

- A linked text finding triggers extra OCR using four overlapping image tiles.
- A visual finding triggers the same extra OCR and rescans associated record
  fields together, to expose context split across fields.
- Successful empty OCR also gets a tiled retry.
- Correlations retain the triggering finding, frame, association basis, and
  independently detected visual findings. A text finding does not invent a visual
  finding when OCR cannot confirm it.

Escalation is one bounded pass per frame. All frames and all record fields still
receive their baseline scan. Batch membership alone is not treated as an exact
record-to-frame attribution.

For more complex schemas, use the TypeScript API and a `locate(record, source)`
callback returning `RecordContext` with explicit media anchors. Callback assets
should be canonical absolute paths and must also be supplied as scan inputs;
the callback owns time conversion and mapping validation.

```ts
import { scan } from "./src/index.ts";

const report = await scan(["/absolute/export/records.jsonl", "/absolute/export/video.mp4"], {
  locate(record: any) {
    return {
      id: record.id,
      anchors: [{ asset: "/absolute/export/video.mp4", seconds: record.offsetMs / 1000 }]
    };
  }
});
```

## Report and scope

`autoredact.scan/v1` reports contain:

- Input paths, SHA-256 hashes, sizes, scanner/rules versions, and scan policy.
- Text-item/frame counts, scrutiny counts, and empty-OCR frame counts.
- Findings with rule IDs and locations: record pointers, frame indexes, presentation
  seconds, and normalized top-left `[x,y,width,height]` boxes.
- Cross-source correlations and incomplete-scan issues.

Matched secrets, source text, and OCR transcripts are not written into reports.
New reports retain all OCR region boxes/IDs and normalized-text fingerprints for masking.
Paths, record IDs, and other locators can still be private; keep reports local.
Inputs are rehashed after scanning to detect changes during a run. The local Swift
worker is built into `~/Library/Caches/autoredact`; transient decoded PNGs live in
private temporary directories and are removed on normal completion/failure.

“No findings” means these rules found nothing in the completed scan, not proof that
the material contains no private information. Successful empty OCR is counted
separately; blank/photo frames are permitted. OCR misses, unusual key formats, and
credentials split across lines remain possible. Audio, secondary video streams,
embedded metadata, and non-secret privacy categories are outside this version's
declared scope.

The implementation bounds decoded-frame storage to one PNG at a time, but currently
holds text records, frame timestamp tables, and the report in memory. A week of
video can take substantial time; start with a selected day. There is no resume
cache yet.

The report separates findings from media manipulation so future classifiers can
add labels without requiring redaction. Daycap retains its separate optimized
native capture implementation; the codified rules can be shared independently.

## Development

```sh
bun run check
bun test
bun run test:ocr
bun run test:review
```

The opt-in OCR integration test generates synthetic `.env`, Cloudflare-style,
Vercel-style, small-text, and clean screenshots. It also creates a three-frame
30 fps video with secrets in only its middle frame, below the screen midpoint.
Tests exercise real Vision OCR, decoding coverage, synchronized escalation,
failure handling, archive verification, and quiet CLI outcomes. No real
credentials or personal recording fixtures are used.

`test:review` runs a real browser workflow using Playwright and local FFmpeg. It
uses Microsoft Edge when installed at its standard macOS location, otherwise
Playwright Chromium (`bunx playwright install chromium`). It verifies exact frame
selection with a two-color video, merged/raw boxes, save/undo/reload, exported
hashes, immutable report bytes, mobile layout, and local API access checks.
