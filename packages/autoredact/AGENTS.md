# Redaction invariants

- Scan reports and source evidence are immutable. Review plans bind to exact report
  bytes; approvals are invalidated whenever effective masks change.
- OCR identity is case-sensitive NFC text with collapsed whitespace, represented by
  a SHA-256 fingerprint. Region IDs alone do not identify text across frames.
- Following requires an explicit inclusive frame range in one source object.
  Physical aliases of identical source hash/frame share edits.
- Mask geometry is normalized top-left `[x,y,width,height]`. Editing a mask never
  changes its original OCR anchor. Render opaque black, round pixel bounds outward,
  and mask before scaling, selection, or lossy encoding.
- `masks.ts` is pure planning/filter construction. `rendition.ts` verifies bindings
  and renders derivatives. Owning adapters handle containers and reference commits;
  imported evidence and historical citations are never rewritten.
- Mask-bearing reviews/publication manifests use v2 so older consumers cannot
  silently approve the original media. Original masked inputs remain withheld.
- Publication cache identity must include the review and rendering engine. Both
  posters and shared video chunks must use the same effective mask plan.
