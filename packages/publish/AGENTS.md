# Publication invariants

- `src/model.ts` defines the versioned wire types; `src/validate.ts` checks wire
  structure and reference integrity. Keep `agent-notes/contract.md` synchronized.
- Public day JSON must not contain local archive locations or consumer routes.
- Resolve discovery once per reader/build. Immutable manifest/day/media objects
  precede the mutable `current.json` pointer. Never silently overwrite immutable
  objects or delete old publications during upload.
- Citations identify exact historical revisions. Activity timelapses are separately
  labelled contextual selections of current captures within activity bounds.
- Each retained source hash/frame index occurs in at most one video chunk per
  publication. Day and activity playlists share those chunks.
- Frame holds and source sample durations are not evidence of continuous coverage.
- Media generation is offline; the portable reader must not import Node, Bun, Git,
  or FFmpeg runtime dependencies.
