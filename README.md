# Vandelay

Importer/exporter.

- `packages/ddb` — The `ddb` CLI. Imports daily activity data from sources such
  as daycap, Dayflow, and ActivityWatch into normalized JSONL records. Maintains
  a "day database"—a day-oriented tree of imports, along with day manifests
  (`2026/11/15.json`) composed of hash-based references to those imports.
- `packages/web` — Exports static Astro web views built against a `ddb` tree.
- `packages/autoredact` — Scans imports—especially screenshots and associated
  metadata from daycap and Dayflow—for critical secrets (passwords, API keys)
  before committing to the day database. This package may expand to provide
  timestamped metadata for publishing, especially by performing frame
  classification and object detection on media.
