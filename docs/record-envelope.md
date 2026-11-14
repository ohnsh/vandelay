# Record envelope

Implemented schema: `did.record/v1`, in `did.bundle/v1` source bundles.
This replaces the initial Vandelay-derived envelope; there is no legacy reader or
automatic migration. Regenerate existing uncommitted collections into a fresh data
repository. The files in an existing repository are not rewritten implicitly.

## Why JSONL still works

A source instance produces a stream of independent JSON records, plus preserved
source evidence. Git commits and hash inventories still define archive snapshots.
The envelope supplies identity, temporal meaning, and optional display fields; a
source adapter owns its content mapping. Email, chat, captures and activities need
not have identical payload schemas to share a web view.

Identity is `(manifest.source.type, manifest.source.instance, record.id)`.
The source namespace is supplied by the bundle rather than repeated on every line.
Consumers combining records from several bundles must carry that namespace along.
IDs are unique within a source bundle and should remain stable when a record appears
in multiple days. Native source rows remain in `evidence.json`.

```ts
interface RecordInput {
  id: string
  kind: string
  time: RecordTime
  title?: string
  text?: string
  data?: unknown
  evidence?: Record<string, unknown>
  interpretation?: 'source-generated' | 'source-reported' |
                   'adapter-derived' | 'human-authored'
  media?: Media[]
  attributes?: Record<string, unknown>
}
```

`record(input, scope)` validates/normalizes time and returns either a record with
`schema` and computed `placement`, or `null` when it does not belong to that day.
It no longer takes positional start/end parameters or spreads arbitrary extra keys
over reserved envelope fields.

`data` is source/type-specific content; `attributes` is additional adapter metadata.
Neither can override identity, time, schema or placement. Optional titles and text
avoid requiring fake empty prose for captures or attachments. Future typed payload
schemas can be added independently of the envelope. The source list includes
ActivityWatch, Dayflow, Daycap and VOD; email/chat collectors are future work.

## Discriminated time union

The discriminator is nested: **`time.model`**, rather than a separate top-level flag.
Each branch accepts only its own fields. `basis` records where the timing claim
comes from, independently of its mathematical shape.

| Model | Fields | Meaning |
|---|---|---|
| `instant` | `at`, `basis` | One timestamp: screenshot, message sent, etc. |
| `interval` | `start`, `end`, `basis` | A source asserts an interval with positive duration. This is not necessarily time worked. |
| `bounds` | `start`, `end`, `basis` | Boundaries of a capture operation or envelope of samples, not continuous activity. Equal endpoints are allowed. |
| `day` | `associations` | Calendar association, not an event lasting all day. |
| `unknown` | `reason`, `associations` | Event time is unknown; archive membership is explicitly supplied. |

Each association is `{day, timezone, role}`. Roles can be `report-day`, `source-day`,
`parent-message-day`, or another documented adapter-specific relationship.
Associations are sorted and duplicates rejected. All associations remain in the
record even when only one matches the containing day bundle.

For `bounds`, basis values such as `capture-request-completion` and
`sample-envelope` distinguish enclosing a single operation from spanning several
observations. Consumers must not infer attention or sum either as time worked.
For `interval`, `source-asserted-interval` distinguishes an inferred Dayflow span
from measured or reported recording duration.

`unknown` is not a default timestamp of zero or “today.” A collector must supply a
reason and explicit association to include it in a daily archive. An entirely
unassociated object belongs in source evidence or a future non-daily object store.

## Examples

Screenshot:

```json
{
  "schema": "did.record/v1",
  "id": "screenshots:20068",
  "kind": "dayflow.screenshots",
  "time": {
    "model": "instant",
    "at": "2026-11-12T06:00:09.000000Z",
    "basis": "capture-timestamp"
  },
  "placement": {
    "model": "instant",
    "at": "2026-11-12T06:00:09.000000Z"
  }
}
```

Dayflow report generated for November 13 with November 12 source material, shown
here in the November 12 bundle:

```json
{
  "schema": "did.record/v1",
  "id": "report:2026-11-13:1",
  "kind": "dayflow.report",
  "time": {
    "model": "day",
    "associations": [
      {"day": "2026-11-12", "timezone": "America/Chicago", "role": "source-day"},
      {"day": "2026-11-13", "timezone": "America/Chicago", "role": "report-day"}
    ]
  },
  "placement": {"model": "day", "roles": ["source-day"]},
  "title": "Dayflow daily report",
  "interpretation": "source-generated"
}
```

The same report in November 13 has identical `id` and `time`, but placement roles
`["report-day"]`. Its generation timestamp, if supplied, remains in source data;
it does not replace the report/source-day associations.

Future email adapter input:

```ts
record({
  id: 'message:example-id',
  kind: 'email.message',
  time: {
    model: 'instant',
    at: '2026-11-12T14:23:10Z',
    basis: 'sent-at',
  },
  title: 'Archive format discussion',
  data: { /* typed email payload: participants, thread, body, attachments */ },
}, bounds)
```

## Membership, clipping and rendering

- UTC RFC 3339 timestamps are normalized to exactly six fractional digits.
  Inputs more precise than microseconds are rejected rather than silently truncated.
  This is representation precision, not a claim of clock accuracy.
- Timed records use the half-open scope `[day.start, day.end)`. Instants at the end
  belong to the next day. Intervals overlap the scope; their placement is clipped.
  Bounds follow the same overlap rule, or point membership for equal endpoints.
- Original `time` is never clipped. `placement` is a derived view for this bundle.
  No legacy top-level `start`, `end`, `visible` or `time_basis` fields are emitted.
- Day/unknown associations match the scope's **date and timezone**, not UTC overlap.
  A local date is not silently converted into an inferred instant in another zone.
  Dayflow currently interprets its date labels in the requested collection timezone.
- `interval` and `bounds` placement has the same respective model and clipped
  `start/end`. `instant` placement has `at`. `day/unknown` placement has matching
  association `roles` and no invented start/end.
- Calendar scopes use Temporal, so DST days may have 23 or 25 hours.
- Sorting puts timed records first by original start/instant, then day-associated
  records, then unknown-time records; ties use kind and ID. This deterministic file
  ordering is not a claim that day-associated content occurred after timed content.
  Render day-associated items in a day header/sidebar and unknown items separately.

A future generic timeline can render these projections without knowing the source,
while specialized views use `kind` and the payload. Message threads and attachments
need not be flattened into activity cards.

## Collector mapping

| Collector content | Time |
|---|---|
| ActivityWatch positive-duration event | `interval`, basis `source-reported-duration` |
| ActivityWatch zero-duration event | `instant`, same basis |
| Dayflow card/observation | `interval`, basis `source-asserted-interval`; zero duration becomes `instant` |
| Dayflow screenshot | `instant`, basis `capture-timestamp` |
| Dayflow standup | `day`, full report/source-day associations |
| VOD recording | `interval`, source timing basis retained |
| Daycap capture | `bounds`, basis `capture-request-completion` |
| Daycap Journal activity/note | `bounds`, basis `sample-envelope` |

`intervalTime(start, end, basis)` is a convenience for sources where a zero-duration
interval really denotes a point. Capture bounds should be supplied explicitly so
equal endpoints do not erase their meaning.

## Validation and versioning

Source manifests declare `record_schema: "did.record/v1"` and adapter version `/2`.
The bundle inventory contains `evidence.json` and `records.jsonl`, plus a derived
`references.json` for Daycap. Hashes cover stored bytes; Daycap evidence preserves
the original export manifest bytes, while derived payloads use did's deterministic serializer. `did.day/v1`, Git
signatures, and OpenTimeStamps are unchanged.

Collection validates records before writing. Verification validates JSONL envelopes,
unique IDs, canonical time, membership and exact derived placement after checking
hashes/counts. Unsupported schemas and unexpected top-level/union fields fail.
Source payload contents and individual media entries are not fully schema-validated
by the envelope validator; collectors retain their existing source/media checks.

This replaces the older envelope rather than introducing an inference-based legacy
reader. The source evidence format and media archive remain independent of the new
record envelope. Existing source bundles must be regenerated in a fresh repository;
their old hashes/schema identifiers must not be patched in place to impersonate v1.
