# Vandelay

Importer/exporter.

- `packages/ddb` — The `ddb` CLI. Imports daily activity data from sources such
  as daycap, Dayflow, and ActivityWatch into normalized JSONL records. Maintains
  a "day database"—a day-oriented tree of imports, along with day manifests
  (`2026/11/15.json`) composed of hash-based references to those imports.
- `packages/publish` — Exports a presentation-oriented projection of a `ddb`
  tree, including per-day activity JSON, web-friendly media assets, and a
  compact, daily preview asset that provides activity highlights and metadata
  needed to play composite timelapse videos.
- `packages/web` — Exports static Astro web views built against a `publish`
  tree.
- `packages/autoredact` — Scans imports—especially screenshots and associated
  metadata from daycap and Dayflow—for critical secrets (passwords, API keys)
  before committing to the day database. This package may expand to provide
  timestamped metadata for publishing, especially by performing frame
  classification or object detection on media.
