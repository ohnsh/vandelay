# Vandelay ddb

- Updated: 2026-11-15. Source commit: `50bf174674c79e1075ebf71334812d1a26abb452` plus workspace migration.
- Status: observation; maintained usage reference.
- Evidence: [`CLI`](../src/cli.ts), [`repository`](../src/repository.ts),
  [workspace scripts](../../../package.json), and collector/repository tests in [`test/`](../test/).
- Limits: commands assume the source repository root as the working directory.
  Signing, timestamps, and media depend on local tools and configuration; revisit
  these instructions when CLI defaults, archive schemas, or tool requirements change.

Collect daily activity into ordinary files, version them with Git, sign commits
with Git, and timestamp signed commits with OpenTimeStamps.

The ActivityWatch, Dayflow and VOD collectors and normalization utilities are
migrated from the predecessor Vandelay implementation. Git replaces the immutable archive store, day revision
chain, composition command and custom signature envelopes.
The Daycap collector imports verified `daycap.export/v3` export directories.

## Setup

`@vandelay/ddb` provides the `ddb` executable. Commands below run from the
workspace root, including `bun run ddb`, which uses the root script. See
[workspace usage](../../../agent-notes/usage.md) for setup and the publication workflow.

Archive schemas, media paths, and web environment variables use `vandelay`.
This is a clean format break: regenerate disposable collections in a fresh data
repository rather than mixing old and new manifests.

Requires Bun 1.3+, Git, and macOS or Linux. Optional tools:

- `ffprobe` (from ffmpeg) for filesystem VOD collection.
- OpenSSH for SSH signatures; FIDO-capable OpenSSH for YubiKeys.
- The reference Python `ots` CLI for timestamps (`uv tool install opentimestamps-client`).

```sh
bun install --frozen-lockfile
bun run ddb init
```

This creates a dedicated **data repository** at `./data`, ignored by this source
project. Pass `--repo /path/to/data` before any subcommand to use another location.
The default object format is SHA-256; use `init --object-format sha1` if your Git
hosting/tooling requires SHA-1. This choice is independent of the ordinary SHA-256
file hashes used in manifests.

Configure the data repository's author and signing key using ordinary Git:

```sh
git -C data config user.name 'Your Name'
git -C data config user.email 'you@example.com'
git -C data config gpg.format ssh
git -C data config user.signingkey ~/.ssh/vandelay-primary
git -C data config commit.gpgsign true
git -C data config gpg.ssh.allowedSignersFile ~/.ssh/vandelay_allowed_signers
```

Use an existing SSH signing key or create a dedicated software key with
`ssh-keygen -t ed25519 -f ~/.ssh/vandelay-signing` and configure its path instead.
The existing Vandelay hardware credential also works with FIDO-capable OpenSSH.
On macOS, install it with `brew install openssh` and put its `bin` directory first
on PATH (or configure Git's `gpg.ssh.program` to its `ssh-keygen`).

The allowed-signers file is an independently trusted file, with one line per key:

```text
you@example.com ssh-ed25519 AAAA...your-public-key...
```

For a hardware key, use its actual `sk-ssh-ed25519@openssh.com` type and public
key bytes. Git uses its standard trust policy; ddb does not implement the predecessor's
additional FIDO UP/UV flag checks. No private keys live in the data repository.

## Collect

```sh
bun run ddb collect activitywatch \
  --day 2026-11-12 --timezone America/Chicago --instance mak \
  --aw-host mak.local

bun run ddb collect dayflow \
  --day 2026-11-12 --timezone America/Chicago --instance mak \
  --media-archive ~/.local/share/vandelay/media

bun run ddb collect daycap \
  --day 2026-11-14 --timezone America/Chicago --instance desktop \
  --daycap-export /path/to/daycap-export \
  --media-archive ~/.local/share/vandelay/media

bun run ddb collect vod \
  --day 2026-11-12 --timezone America/Chicago --instance media-days \
  --vod-root /Volumes/Media/days --vod-config ../vod/vod.config.json
```

Collection replaces one source instance's current selection and preserves the
other sources already selected for the day. Recollecting identical content makes
no file changes. Errors reading a source fail collection; an available source with
no matching records is valid. No live source database or media file is modified.
Commands emit JSON; operational bucket observations are returned in this output
rather than incorporated into content identities.

The date determines activity membership, not the commit date. Late arrivals and
corrections update the same pathname in a later commit. Each repository supports
one timezone per date; a conflicting scope is rejected.

`--timezone` defaults to the JavaScript runtime's timezone via
`Intl.DateTimeFormat().resolvedOptions().timeZone`. The runtime handles `$TZ`
and system configuration (normally `/etc/localtime` on Unix). An explicit
`--timezone` overrides this default.

### Source options and semantics

- **ActivityWatch:** `--aw-host` selects all buckets for that hostname, separately
  from the stable `--instance` name. `--aw-url` defaults to `http://localhost:5600`.
  Use `--aw-export file.json` for an offline export of the form
  `{"buckets":{"id":{"hostname":"mak.local","type":"window","events":[]}}}`.
  Events overlapping midnight are retained. HTTP buckets are read separately,
  not as an atomic server snapshot; querying all earlier starts can be slow.
- **Dayflow:** `--dayflow-db` defaults to
  `~/Library/Application Support/Dayflow/chunks.sqlite`. One read-only SQLite
  transaction reads committed WAL data, preserves deleted cards as evidence,
  and includes reports associated by report date or `generation.sourceDay`.
   Selected rows and schemas are retained, along with screenshots, related analysis
   batches, and their screenshot associations. Batch inputs and whole-segment frame
   maps outside the day are included as evidence; screenshot activity records
   belong to their capture day. Whole segments may contain footage outside the day.
   Screenshot `file_path` is replaced by a `media` object with SHA-256, byte size,
   and an archive-relative location (or an explicit unavailability status).
   Screenshots also include sorted, unique `batch_ids` (empty when unassociated),
   both in record `data` and in evidence. Join these to observation `data.batch_id`
   to identify shared analysis inputs; this is batch membership, not direct
   observation-to-frame attribution. Original junction rows remain in evidence,
   including associations for out-of-day whole-segment frames.
   AI interpretations remain attributed to Dayflow.
- **Daycap:** `--daycap-export` selects a completed v3 export directory containing
  `manifest.json`, `manifest.sha256`, and inventoried media. An explicit stable
  `--instance` identifies the source store. Original manifest bytes become
  `evidence.json`; captures, Journal notes/cards/analyses/gaps, Evidence analyses/
  activities, and withdrawals become `vandelay.record/v1` records. Media is verified and
  copied to the external content-addressed archive. `references.json` is a
  deterministic dependency index rebuilt during verification. See
  [Daycap mapping and limitations](daycap.md).
- **VOD filesystem:** reads `YYYY-MM/DD/_camera/file.{mp4,mov,m4a,opus}`.
  `--vod-config` supports timezone, source timing rules, timelapse wall duration,
  and per-object timestamp overrides as in Vandelay. `--camera name` is repeatable;
  give subsets distinct instance names. `--lookback-days` defaults to 1, bounding
  overlap discovery. Missing directories do not establish inactivity. Ambiguous
  local times require an explicit fold or UTC override. Included media is hashed
  and checked for changes during probing/hashing.
- **VOD catalog:** use `--vod-db /path/to/snapshot.sqlite`, optionally with
  `--vod-root`. Catalog overlap and related recording/source/rendition/asset rows
  are retained. Available local originals are hashed and compared to catalog
  claims; remote existence is not inferred. There is no live catalog downloader,
  SQL dump restore or remote media fetcher.

Records use the `vandelay.record/v1` envelope with a discriminated `time.model`:
`instant`, `interval`, `bounds`, `day`, or `unknown`. Original times remain intact;
`placement` supplies a derived day projection. Reports keep explicit calendar
associations rather than fabricated day-long intervals. See the
[record envelope notes](record-envelope.md).

Timed records preserve microsecond timestamps and half-open day bounds. DST days
are calendar days, not assumed to be 24 hours. Unsafe SQLite integers fail rather
than round.

### Dayflow media archive

`--media-archive` defaults to `~/.local/share/vandelay/media`. It must live outside Git
repositories and outside the source Dayflow database directory. Back this directory
up separately: Git contains references, not media bytes. References are relative,
so the archive can be relocated without changing signed records.

Finalized MP4 segments (and legacy screenshot files) are copied to
`sha256/HH/FULL_SHA256` beneath the archive root. Files have no extension; their
bytes are unchanged. Copies are hashed and checked against the source, checked for
concurrent changes, and published without overwriting existing objects. Existing
objects are verified before reuse. A segment shared by many frames or days is
stored once.

The archive is append-only, not a replaceable daily bundle. Recollection updates
the day's Git-tracked references; changed source bytes create a new object while
old objects remain available to historical commits. No automatic garbage collection
is performed. Interrupted collections may leave unreferenced complete objects.

Dayflow's `file_size IS NULL` marks unfinalized MP4 frame rows. These segments are
reported as `pending-finalization` and retried on recollection; absent files are
reported as `missing`. Already archived objects are retained even if Dayflow later
deletes its source, but a fresh collection does not infer their identity from a
missing source pathname. Old committed references still resolve to the archive.
The SQLite snapshot and media copies are not one atomic source snapshot.

Preserve `captured_at` and `frame_index`: the current Dayflow MP4 stores frame N at
presentation time N seconds, independently of capture cadence or wall-clock gaps.
Screenshot records are point observations, not claims of continuous recording.
No redaction or frame removal is performed.

## Verify and sign a snapshot

```sh
bun run ddb verify 2026-11-12
git -C data diff
git -C data add .gitattributes 2026/
git -C data commit -S -m 'Collect 2026-11-12'

bun run ddb verify 2026-11-12 --commit HEAD --signature
git -C data log -- 2026/11/12.json
git -C data show HEAD:2026/11/12.json
```

`verify` checks scope/source consistency, manifest and payload SHA-256 hashes and
sizes, JSON/JSONL parsing, record counts, unique IDs, and record time/placement
semantics. `--commit` reads exact Git blobs,
independently of uncommitted edits; `--signature` additionally invokes Git's commit
signature verification. External media bytes are not rehashed by this command.
The working-tree manifest itself becomes authenticated when its Git commit is
verified, not merely by running a hash inventory check.

Collection serializes ddb writers using a lock inside `.git`; Git operations
should run after collection completes. Files are individually atomically replaced
and the day manifest is written last. The working-tree update is not a multi-file
transaction; Git's commit is the atomic snapshot. If collection is interrupted
mid-write, restore the affected day's tracked files from the last good commit
(preserving any intentional uncommitted work first), then recollect. Verification
rejects inconsistent partial updates.

## Timestamp a signed commit

```sh
bun run ddb timestamp stamp HEAD
```

The command resolves HEAD once, verifies the commit signature using Git's configured
trust policy, and exports exactly `git cat-file commit <id>`—including the embedded
signature. It then runs `ots stamp` on those bytes. The JSON result includes the
resolved commit ID; **use that ID for later operations**, since HEAD will move:

```sh
bun run ddb timestamp upgrade COMMIT_ID
bun run ddb timestamp verify COMMIT_ID
bun run ddb timestamp info COMMIT_ID
```

Proofs live in the **same data repository**, under:

```text
proofs/COMMIT_ID/
  commit                       # exact signed commit bytes
  commit.ots                   # detached OTS proof
  history/PROOF_SHA256.ots      # previous proof bytes, saved before upgrades
```

Commit these in a subsequent commit:

```sh
git -C data add proofs/
git -C data commit -S -m 'Record timestamp proofs'
```

There is no self-reference: the proof commit follows the activity snapshot. A
separate proof repository would add coordination without improving this proof.
Proof-only commits need not themselves be timestamped; later collection snapshots
can include earlier proofs naturally. Upgrades are also ordinary working-tree
changes to commit. Nothing implicitly commits, signs or publishes data.

Stamping is idempotent when a proof exists. Proof presence and a successful upgrade
are **not** successful verification; only successful `ots verify` is reported as
`externally-verified`. Pending anchors and unavailable verification backends cause
verification to fail. Use the OTS CLI's own calendar/Bitcoin verification configuration.
The timestamp establishes an existence bound for the signed commitment, not the
truth or completeness of recorded activity. Git's dates remain local-clock claims.

## Data format and future portability

```text
data/
  .git/
  .gitattributes
  2026/11/12.json
  2026/11/12/activitywatch/mak/manifest.json
  2026/11/12/activitywatch/mak/evidence.json
  2026/11/12/activitywatch/mak/records.jsonl
  2026/11/12/dayflow/mak/...
  2026/11/12/vod/media-days/...
  proofs/...
```

Day manifests have this shape (abbreviated):

```json
{
  "schema": "vandelay.day/v1",
  "scope": {
    "day": "2026-11-12",
    "timezone": "America/Chicago",
    "start": "2026-11-12T06:00:00.000000Z",
    "end": "2026-11-13T06:00:00.000000Z"
  },
  "sources": {
    "dayflow/mak": {
      "path": "2026/11/12/dayflow/mak/manifest.json",
      "sha256": "...",
      "bytes": 1234
    }
  }
}
```

Paths are repository-relative. Source manifests use `vandelay.bundle/v1`:
scope, source, producer, coverage, record count, and an inventory of `evidence.json`
and `records.jsonl` (also `references.json` for Daycap) with ordinary SHA-256 hashes and byte sizes, plus
`record_schema: "vandelay.record/v1"`. The producer is `@vandelay/ddb/0.1.0`; adapter versions are
`source/2`. Evidence locators in records are
relative to their source directory. Media remains external with SHA-256 identities,
sizes and location hints; this repository does not back up media bytes.

JSON uses Vandelay's sorted-key UTF-8 encoding with a trailing LF, not RFC 8785.
Verification hashes stored bytes, never reserialized JSON. `.gitattributes` disables
text conversion and clean/smudge filters so stored bytes are stable across platforms.

Git supplies parent history instead of a domain `parent` field. A day version is
identified by `(commit ID, date path)`. Other archive layouts can consume the source
evidence and normalized records through explicit adapters. Preserve original signed
Git objects and OTS proofs when transforming archives: old signatures do not directly
authenticate newly serialized day objects.

The initial Vandelay-derived record/bundle envelope has been replaced without a
compatibility reader. Regenerate earlier uncommitted collections into a fresh data
repository; existing data files are not migrated automatically.

A standalone day proof can be built from the signed commit, its OTS proof, the raw
Git trees along the manifest's path, and the manifest's hash-linked payloads. The
package exporter/verifier is not part of this initial CLI. Ordinary clones or full
Git bundles preserve history today; plain `git archive` exports omit signature
and inclusion evidence. Keep an independent trusted commit ID if detecting rollback
matters: branch names and valid old snapshots do not establish which is latest.

## Development

```sh
bun run --cwd packages/ddb check
bun run --cwd packages/ddb test
```

Tests cover all four collectors, DST/overlap behavior, source replacement,
idempotence, historical reads, tamper rejection, actual SSH-signed SHA-1/SHA-256
commits, CLI collection, and OTS command lifecycle/failure behavior. OTS networking
is mocked; tests use temporary software SSH keys rather than hardware tokens.
