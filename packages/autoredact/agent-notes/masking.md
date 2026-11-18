# Reviewed renditions

- Date: 2026-11-18; source baseline: `5374ec4f6c99ce93ee3004f1cdca393c066ebe2a`
  plus the accompanying implementation.
- Status: accepted architectural direction (user-approved); implementation observation.
- Evidence: `src/masks.ts`, `src/rendition.ts`, `src/review/store.ts`,
  `web/mask-editor.tsx`, `test/masks.test.ts`, and `../publish/src/media.ts`.
- Limits: imported/exported material only; no live Dayflow database edits or Daycap
  native-store reuse. Revisit if source ownership or publication projection changes.

## Boundaries

Planning is independent of storage. Scans retain a presentation-order frame inventory
and OCR region IDs, normalized boxes and text fingerprints, without OCR plaintext.
Mask plans bind through the review's exact report hash to source content hashes.
The editor can address every inventoried frame, including ones without findings.
Legacy scans remain reviewable; rescan to obtain the inventory needed for masking.

`planMasks` replaces one origin's masks and recomputes its bounded expansions.
Anchors retain original region geometry while the editable rectangle moves/resizes.
Following transfers relative geometry to all exact normalized-text matches in other
selected frames. No fuzzy matching, optical tracking, cross-line reconstruction, or
future-capture rules are inferred. The selected origin keeps its explicit rectangle.
Identical physical hash/frame aliases receive the same edits. Generated masks are
edited at their origin; another frame can add independent masks.

Plan updates share the review store's exclusive lock, disk-hash checks and atomic
replacement. Every changed mask list clears that frame's decision, including when
removing propagation. Scans do not mutate. `validatePlan` reconstructs expansions
from origin masks to reject stale or inconsistent persisted plans.

Reviews with a mask plan use `autoredact.review/v2`; corresponding decision exports
use `autoredact.publication/v2`. This deliberately prevents older v1 consumers from
silently ignoring masks. The original masked input remains withheld even when its
derivative is approved. Unflagged, unedited frames do not require an explicit decision.

## Derivatives and publication

`render-review` writes an exclusive output directory containing lossless masked PNG
replacements and an `autoredact.rendition/v1` manifest. Mappings retain exact source
hash/frame/PTS and output hash/frame. The manifest is written last; failures remove
the new directory. Parent media is decoded sequentially with one raster retained.
This is a replacement-frame set, not a complete publication or reconstructed movie.

The Vandelay publisher instead applies the same filters while assembling its existing
shared chunks. Masking precedes selection/scaling/encoding; source hashes, selectors
and historical citations retain their original meaning. Both posters and chunks bind
their cache recipes to report/review hashes and the mask/render engine source digest.
Withheld frames have no playback; masked pixels cannot leak through an unmasked poster.

The adapter requires complete scan/review, verifies source bytes before and after
rendering, and binds the selected pinned bundle manifest, records, evidence and
Daycap references to scanned text inputs. Withheld text blocks the build: replacing
or projecting away arbitrary text fields is not implemented. External original-media
URL overrides are rejected for reviewed builds. No review/OCR plaintext, local
source paths, or mask drafts are added to public artifacts.

Already generated publications remain immutable; a new rendition cannot recall
older exports. Re-encoding a masked frame does not imply that an earlier analysis
used those pixels. Public configuration records exact report/review/recipe hashes.

## Checks

`bun run check`, `bun test`, and `bun run test:review` in AutoRedact exercise
normalization, scope, aliases, review invalidation, persistence/concurrency,
lossless output pixels and the browser editor. Publisher tests decode both posters
and videos, verify withholding and shared-frame mappings, and reuse the same cache
across original and redacted builds.
