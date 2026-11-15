# Daycap collector

- Updated: 2026-11-15. Source commit: `f6704667bf9b32d4de7ce4e52cf1a76320985a8b`.
- Status: observation of the implemented importer and its limits.
- Evidence: [`src/daycap.ts`](../src/daycap.ts),
  [`src/repository.ts`](../src/repository.ts), and
  [`test/daycap.test.ts`](../test/daycap.test.ts).
- Limits: applies to `daycap.export/v2` and adapter `daycap/2`; revisit if the
  producer schema, identity rules, or reference resolution changes. Producer
  completeness and frame-to-wall-time accuracy are not independently established.

Run commands from the source repository root.

```sh
bun run did collect daycap \
  --day 2026-11-14 --timezone America/Chicago --instance desktop \
  --daycap-export /path/to/daycap-export \
  --media-archive ~/.local/share/did/media
```

The input is an existing `daycap.export/v2` directory. Its manifest checksum and
every inventoried object's hash/size must verify. Paths must stay within the export,
including through symlinks. Missing or corrupt inventoried objects fail collection.
Media bytes are copied using the same external content-addressed archive as Dayflow.
The importer validates frame-index/PTS integer structure; it does not decode movies
or independently verify the producer's frame-to-wall-time mapping.

Use a stable `--instance` for each independent Daycap store. The export does not
supply a persistent store UUID. Changing machine names should not rename history.

## Preserved and normalized payloads

Each bundle inventories:

- `evidence.json`: **exact original manifest bytes**, without reserialization.
- `records.jsonl`: sorted `did.record/v1` records, using typed Daycap payloads in
  `data`, evidence JSON Pointers, and source-qualified references.
- `references.json`: a deterministic `did.references/v1` dependency index.

The bundle coverage records export ID, original selection scope, source schema,
manifest hash, diagnostics, and completeness limitations. The adapter is `daycap/2`.

| Source entity | Normalized ID | Time |
|---|---|---|
| Observation capture | `capture/<id>` | Request/completion bounds |
| Observation gap | `gap/<id>` | Recorded bounds, including zero-length markers |
| Journal attempt | `journal/<batch>/attempt/<n>` | Input coverage bounds |
| Journal note | `<attempt>/note/<sample>` | Sample capture bounds |
| Journal card | `<attempt>/card/<card>` | Envelope of explicitly cited samples |
| Journal gap | `journal/<batch>/gap/<ordinal>` | Producer-derived discontinuity bounds |
| Evidence analysis | `analysis/<id>` | Declared input bounds, or capture envelope |
| Evidence activity | `analysis/<id>/activity/<ordinal>` | Cited capture envelope, or analysis coverage when uncited |
| Withdrawal | `withdrawal/<content-sha256>` | Event instant |

Withdrawal table UUIDs are not exported. Their fallback IDs hash the deterministic
serialization of exported event fields, with original decimal date tokens retained.
They identify exported event content, not a producer UUID.

Journal details stay ordered and nested inside cards. Notes must cover selected
samples exactly once in sample order; card details must partition those samples
exactly once. Each detail must be chronological and remain in one logical stream/run.
Active-display streams may cross physical displays. Source taxonomies and confidence
claims are preserved. Captures are distinct from generated observations.

`data.relations` carries explicit supports, generation links, input membership,
context links, outputs, and resolved continuations. Input membership is not direct
support. Nested detail supports and analysis input references retain exact sample
revisions. Additional source fields, including masks, OCR, application state, request
contents, and policy details, remain addressable through evidence pointers.

Decimal Unix milliseconds are read from original JSON number tokens, rounded to the
nearest microsecond with ties to even, and normalized to UTC. Captures and sample
envelopes use `bounds`, not continuous activity intervals. Original time is retained;
`placement` clips to the requested calendar day, including DST boundaries.
Reversed capture/batch/gap bounds are omitted from projection with evidence-backed
diagnostics. A Journal with reversed sample bounds has its projection omitted.
Other malformed structures fail collection.

## Media and historical inputs

Capture media always resolves from exported observations. Each current video
reference includes its segment hash and frame selector with actual presentation
microseconds at timescale 1,000,000. Presentation time is independent of wall time.

Journal analysis inputs separately retain:

- Historical capture revision.
- Submission-time segment/image hash and frame selector (`referenced`).
- Submitted PNG hash (`not-retained`).
- Pointer to the exact sample snapshot, including submitted masks.

Current archived bytes never substitute for a historical submission. Re-encoding
does not establish a complete rendition lineage. Metadata-only and withdrawn
captures have no normalized media or narrative.

## Rebuilding references

`daycapReferences(evidenceBytes, records, instance)` is pure. The instance is the
enclosing bundle's source namespace; there are no live-store or neighboring-bundle
lookups. Entries are sorted by deterministically serialized source-qualified target
identity/revision:

- `included`: the exact identity/revision exists in `records.jsonl`.
- `evidence-only`: an exact capture, historical sample snapshot, or generated
  object is addressable by JSON Pointer in evidence. A sample snapshot supplies
  historical metadata; it does not imply retained historical media or a full capture.
- `unavailable`: no matching object exists locally. `withdrawn` is used only when
  an explicit withdrawal targets that revision; otherwise the reason is `unknown`.

Context snapshots lacking an established generation appear separately in
`unresolved`, with their original batch/context identity, evidence pointer, and
`generation-not-established` reason. They are not assigned guessed attempt IDs.
A continuation resolves only against an included predecessor whose title, supplied
summary snapshot, and last-sample time match and whose batch precedes this one.
Prior-day predecessors can resolve to evidence without becoming today's activity.

Verification checks evidence pointers and rebuilds the index from inventoried
payloads, requiring byte-for-byte agreement. This detects a false index even if its
hash inventory has been recomputed. This is not full re-execution of the collector
or revalidation of every source payload field. External bundle pins are not emitted.

## Coverage limits

The source export selects captures by request time. Journal batches must start in
range and have all assigned captures selected. Only completed analyses are exported;
failed, pending, skipped, held, and overwritten attempts are not reconstructible.
An export is not arbitrary overlap closure for a different day or timezone.

Context may escape the export; supplied summary snapshots remain evidence.
Withdrawal lifecycle and affected generated IDs may be incomplete. Missing source
objects are not proof of withdrawal or inactivity. Completed analyses referencing
explicitly withdrawn captures are rejected as inconsistent exports.

The collector does not infer historical generation identities, rebuild withheld
text, or propagate deletions into old Git commits or archived media. Signed snapshots
retain their historical bytes.
