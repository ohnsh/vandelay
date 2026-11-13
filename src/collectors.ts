import { Database, type SQLQueryBindings } from 'bun:sqlite';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { command } from './io.ts';
import { archiveMedia, archiveRoot, defaultMediaArchive } from './media-archive.ts';
import { addSeconds, clip, compare, encode, epoch, expand, fileHash, instant, localInstant, record, safePath, seconds, Temporal,
  type ActivityRecord, type Collected, type Media, type Scope } from './model.ts';

// Native source rows are deliberately open: retain unknown source fields as evidence.
type Row = Record<string, any>;
export interface VodRule { mode?: string; timezone?: string; preferredTimestampField?: string; wallDurationSeconds?: number; fold?: string }
export interface VodOverride { startUtc?: string; fold?: string; wallDurationSeconds?: number }
export interface VodConfig {
  timezone?: string; sources?: Record<string, VodRule>; cameras?: Record<string, VodRule>;
  timestampOverrides?: Record<string, VodOverride>;
  [key: string]: unknown;
}
export function sqliteRead(path: string): Database {
  const db = new Database(expand(path), { readonly: true, strict: true, safeIntegers: true });
  db.run('PRAGMA query_only=ON');
  db.run('BEGIN');
  return db;
}
function rows(db: Database, sql: string, args: SQLQueryBindings[] = []): Row[] {
  return db.query<Row, SQLQueryBindings[]>(sql).all(...args).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value === 'bigint') {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error(`SQLite integer outside JavaScript's safe range: ${key}`);
      return [key, number];
    }
    return [key, value];
  })));
}
export function result(records: ActivityRecord[], evidence: unknown, method: string, limitations: string[], coverage: Record<string, unknown> = {}): Collected {
  return { records: records.sort((a, b) => compare(a.start, b.start) || compare(a.id, b.id)), evidence,
    coverage: { state: 'observed', method, limitations, ...coverage } };
}
export async function activitywatch(bounds: Scope, host: string, base = 'http://localhost:5600', exported?: string): Promise<Collected> {
  async function get(path: string): Promise<any> {
    const response = await fetch(base.replace(/\/$/, '') + '/api/0' + path, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`ActivityWatch ${response.status}: ${path}`);
    return response.json();
  }
  const snapshot = exported ? JSON.parse(readFileSync(expand(exported), 'utf8')) : null;
  const available: Record<string, Row> = snapshot ? snapshot.buckets : await get('/buckets/');
  const selected = Object.entries(available).sort(([a], [b]) => compare(a, b)).filter(([, b]) => b.hostname === host);
  if (!selected.length) throw new Error(`No ActivityWatch buckets for host ${host}`);
  const buckets: Record<string, unknown> = Object.create(null), observations: Record<string, unknown> = Object.create(null), records: ActivityRecord[] = [];
  for (const [key, bucket] of selected) {
    // AW filters on event start, not overlap. Don't impose a lower start bound.
    const events: Row[] = snapshot ? bucket.events : await get(`/buckets/${encodeURIComponent(key)}/events?` + new URLSearchParams({ end: bounds.end, limit: '-1' }));
    if (!Array.isArray(events)) throw new Error(`Missing events for AW bucket ${key}`);
    const kept: Row[] = [];
    for (const event of events) {
      if (typeof event.duration !== 'number' || !Number.isFinite(event.duration) || event.duration < 0) throw new Error(`Invalid AW duration in ${key}`);
      if (!['number', 'string'].includes(typeof event.id) || !event.data || typeof bucket.type !== 'string') throw new Error(`Invalid AW event/bucket: ${key}`);
      const start = instant(event.timestamp), end = addSeconds(start, event.duration), data = event.data;
      const r = record(`${key}:${event.id}`, 'activitywatch.' + bucket.type, start, end, bounds,
        String(data.app ?? data.status ?? bucket.type), String(data.title ?? data.url ?? ''),
        { evidence: { file: 'evidence.json', bucket: key, id: event.id }, data });
      if (r) { records.push(r); kept.push(event); }
    }
    const { last_updated, events: _, ...metadata } = bucket;
    observations[key] = { last_updated: last_updated ?? null };
    buckets[key] = { ...metadata, events: kept.sort((a, b) => compare(a.timestamp, b.timestamp) || compare(String(a.id), String(b.id))) };
  }
  return { ...result(records, { buckets }, exported ? 'aw-export' : 'aw-http',
    ['Buckets are not a server-wide atomic snapshot; absence is not proof of inactivity.'], { host }), observations };
}
export function dayflow(bounds: Scope, path: string, mediaArchive = defaultMediaArchive): Collected {
  const db = sqliteRead(path), records: ActivityRecord[] = [], evidence: Record<string, unknown> = {};
  try {
    const lo = seconds(instant(bounds.start)), hi = seconds(instant(bounds.end));
    for (const table of ['timeline_cards', 'observations']) {
      const selected = rows(db, `SELECT * FROM "${table}" WHERE start_ts < ? AND end_ts >= ? ORDER BY start_ts,id`, [hi, lo]);
      evidence[table] = selected;
      for (const row of selected) {
        if (table === 'timeline_cards' && row.is_deleted) continue;
        const r = record(`${table}:${row.id}`, 'dayflow.' + table, epoch(row.start_ts), epoch(row.end_ts), bounds,
          String(row.title ?? ''), ['summary', 'detailed_summary', 'observation'].map(k => String(row[k] ?? '')).join('\n').trim(),
          { evidence: { file: 'evidence.json', table, id: row.id }, interpretation: 'source-generated', data: row });
        if (r) records.push(r);
      }
    }
    const reports: Row[] = [];
    for (const row of rows(db, 'SELECT * FROM daily_standup_entries ORDER BY standup_day')) {
      const payload = JSON.parse(row.payload_json), sourceDay = payload.generation?.sourceDay ?? null;
      if (row.standup_day === bounds.day || sourceDay === bounds.day) {
        reports.push(row);
        records.push(record(`report:${row.standup_day}:${row.id ?? ''}`, 'dayflow.report', instant(bounds.start), instant(bounds.end), bounds,
          'Dayflow daily report', encode(payload).toString().trimEnd(),
          { time_basis: 'day-associated-not-event-time', data: payload, report_day: row.standup_day, source_day: sourceDay })!);
      }
    }
    evidence.daily_standup_entries = reports;
    const tables = ['timeline_cards', 'observations', 'daily_standup_entries', 'screenshots', 'batch_screenshots', 'analysis_batches'];
    evidence.schema = rows(db, `SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN (${tables.map(() => '?').join(',')}) ORDER BY name`, tables);
    const available = new Set((evidence.schema as Row[]).map(row => row.name));
    if (available.has('screenshots')) {
      const root = archiveRoot(mediaArchive, dirname(expand(path)));
      const batchIDs = new Set<number>();
      for (const table of ['timeline_cards', 'observations']) {
        for (const row of evidence[table] as Row[]) if (row.batch_id != null) batchIDs.add(row.batch_id);
      }
      const screenshots = rows(db, 'SELECT * FROM screenshots WHERE captured_at >= ? AND captured_at < ? ORDER BY captured_at,id', [lo, hi]);
      const selectedIDs = new Set(screenshots.map(row => row.id));
      const links = available.has('batch_screenshots') ? rows(db, 'SELECT * FROM batch_screenshots ORDER BY batch_id,screenshot_id') : [];
      for (const link of links) if (selectedIDs.has(link.screenshot_id)) batchIDs.add(link.batch_id);
      const selectedLinks = links.filter(link => batchIDs.has(link.batch_id));
      for (const link of selectedLinks) {
        if (selectedIDs.has(link.screenshot_id)) continue;
        const screenshot = rows(db, 'SELECT * FROM screenshots WHERE id = ?', [link.screenshot_id])[0];
        if (!screenshot) throw new Error(`Missing Dayflow screenshot row: ${link.screenshot_id}`);
        screenshots.push(screenshot); selectedIDs.add(screenshot.id);
      }
      evidence.batch_screenshots = selectedLinks;
      evidence.analysis_batches = available.has('analysis_batches')
        ? [...batchIDs].sort((a, b) => a - b).flatMap(id => rows(db, 'SELECT * FROM analysis_batches WHERE id = ?', [id])) : [];
      // Whole segments are archived, so preserve their complete available frame maps.
      for (const file of new Set(screenshots.map(row => row.file_path))) {
        for (const row of rows(db, 'SELECT * FROM screenshots WHERE file_path = ? ORDER BY captured_at,id', [file])) {
          if (!selectedIDs.has(row.id)) { screenshots.push(row); selectedIDs.add(row.id); }
        }
      }
      const media = new Map<string, Media | { availability: string }>();
      evidence.screenshots = screenshots.sort((a, b) => a.captured_at - b.captured_at || a.id - b.id).map(row => {
        const { file_path, ...fields } = row;
        if (typeof file_path !== 'string' || !file_path) throw new Error('Invalid Dayflow screenshot file_path');
        if (!media.has(file_path)) {
          const source = file_path.startsWith('file:') ? fileURLToPath(file_path) : expand(file_path);
          // FrameStore sets file_size only after finalizing a segment. Check all its rows,
          // including captures outside this day, before attempting a copy.
          const pending = row.frame_index != null && rows(db,
            'SELECT id FROM screenshots WHERE file_path = ? AND file_size IS NULL LIMIT 1', [file_path]).length > 0;
          media.set(file_path, !existsSync(source) ? { availability: 'missing' }
            : pending ? { availability: 'pending-finalization' }
            : archiveMedia(source, root));
        }
        const asset = media.get(file_path)!;
        const saved = { ...fields, media: asset };
        const r = record(`screenshots:${row.id}`, 'dayflow.screenshots', epoch(row.captured_at), epoch(row.captured_at), bounds,
          '', '', { evidence: { file: 'evidence.json', table: 'screenshots', id: row.id }, data: saved,
            ...('sha256' in asset ? { media: [asset] } : {}) });
        if (r) records.push(r);
        return saved;
      });
    }
    return result(records, evidence, 'sqlite-read-transaction', [
      'Screenshot file_path is replaced by an archive-relative SHA-256 media reference or explicit unavailability; native schemas describe the source rows.',
      'Batch inputs and whole-segment frame maps can fall outside the day. Capture timestamps, not MP4 duration, establish wall time.',
      'Pending segments and missing media are not copied; recollect after finalization. SQLite and media are not a single atomic snapshot.',
      'AI interpretations remain attributed to Dayflow; deleted cards are retained only as evidence.',
    ]);
  } finally { db.close(); }
}

export function probe(path: string): Row {
  const data = JSON.parse(command(['ffprobe', '-v', 'error', '-show_format', '-show_streams', '-of', 'json', path]).toString());
  if (data.format) delete data.format.filename;
  return data;
}
export function statStamp(path: string): string {
  const s = statSync(path, { bigint: true });
  return [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
}
export function localAsset(path: string, root: string): Media {
  const before = statStamp(path), bytes = statSync(path).size, sha256 = fileHash(path);
  if (statStamp(path) !== before) throw new Error(`Media changed while hashing: ${path}`);
  return { sha256, bytes, role: 'original', location: { kind: 'archive-relative', path: relative(root, path) } };
}
export function filenameTime(name: string, day: string, zone: string, rule: VodRule, override: VodOverride, metadata: Row): [Temporal.Instant, string] {
  if (override.startUtc) return [instant(override.startUtc), 'config-startUtc'];
  const field = rule.preferredTimestampField, tags = metadata.format?.tags ?? {};
  if (field && field in tags) return [instant(tags[field]), 'metadata-' + field];
  const hourly = /^(\d{1,2})(?:[-_]\d+)?\.(?:mp4|mov|m4a|opus)$/i.exec(name);
  const compact = /(?:^|[_-])(\d{4})(\d{2})(\d{2})[_T-](\d{2})(\d{2})(\d{2})(?:[-_]\d+)*\.(?:mp4|mov|m4a|opus)$/i.exec(name);
  const dashed = /(?:^|[_-])(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})[-:](\d{2})[-:](\d{2})(?:[-_]\d+)?\.(?:mp4|mov|m4a|opus)$/i.exec(name);
  const match = compact ?? dashed;
  let local: string;
  if (hourly) local = `${day}T${hourly[1].padStart(2, '0')}:00:00`;
  else if (match) {
    const [, y, m, d, h, minute, second] = match;
    if (`${y}-${m}-${d}` !== day) throw new Error(`Filename disagrees with folder: ${name}`);
    local = `${day}T${h}:${minute}:${second}`;
  } else if (tags['com.apple.quicktime.creationdate']) return [instant(tags['com.apple.quicktime.creationdate']), 'metadata-quicktime'];
  else throw new Error(`Cannot resolve recording time: ${name}; supply a VOD DB or startUtc override`);
  return [localInstant(local, zone, override.fold ?? rule.fold ?? 'reject'), 'filename'];
}
export function vodFiles(bounds: Scope, directory: string, config: VodConfig, cameras: string[] = [], lookback = 1,
  inspect: (path: string) => Row = probe): Collected {
  if (!Number.isSafeInteger(lookback) || lookback < 0) throw new Error('lookback days must be a nonnegative integer');
  const root = expand(directory);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`Archive root missing: ${root}`);
  const records: ActivityRecord[] = [], evidence: { config: VodConfig; files: unknown[] } = { config, files: [] };
  const zone = config.timezone ?? bounds.timezone;
  const first = instant(bounds.start).toZonedDateTimeISO(zone).toPlainDate().subtract({ days: lookback });
  const last = instant(bounds.end).toZonedDateTimeISO(zone).toPlainDate();
  const examined: string[] = [], missing: string[] = [];
  for (let day = first; Temporal.PlainDate.compare(day, last) <= 0; day = day.add({ days: 1 })) {
    const dayString = day.toString(), dayPath = `${dayString.slice(0, 7)}/${dayString.slice(8)}`, path = join(root, dayPath);
    examined.push(dayPath);
    if (!existsSync(path) || !statSync(path).isDirectory()) { missing.push(dayPath); continue; }
    const paths: string[] = [];
    for (const name of readdirSync(path).sort(compare)) {
      const cameraDir = join(path, name);
      if (!statSync(cameraDir).isDirectory()) continue;
      for (const filename of readdirSync(cameraDir).sort(compare)) paths.push(join(cameraDir, filename));
    }
    for (const file of paths) {
      if (!['.mp4', '.mov', '.m4a', '.opus'].includes(extname(file).toLowerCase())) continue;
      const camera = basename(dirname(file)).replace(/^_+/, '');
      if (cameras.length && !cameras.includes(camera)) continue;
      const key = relative(root, file);
      safePath(root, key);
      const rule = (config.sources ?? config.cameras ?? {})[camera] ?? {}, override = config.timestampOverrides?.[key] ?? {};
      const before = statStamp(file), metadata = inspect(file);
      const [start, basis] = filenameTime(basename(file), dayString, rule.timezone ?? zone, rule, override, metadata);
      const duration = Number(metadata.format?.duration), wall = override.wallDurationSeconds ?? rule.wallDurationSeconds ?? duration;
      if (!Number.isFinite(duration) || !Number.isFinite(wall) || duration <= 0 || wall <= 0) throw new Error(`Invalid recording duration: ${key}`);
      if (rule.mode === 'timelapse' && override.wallDurationSeconds === undefined && rule.wallDurationSeconds === undefined) throw new Error(`Timelapse requires wallDurationSeconds: ${key}`);
      const end = addSeconds(start, wall);
      if (!clip(start, end, bounds)) continue;
      const asset = localAsset(file, root);
      if (statStamp(file) !== before) throw new Error(`Media changed during probing: ${key}`);
      evidence.files.push({ path: key, probe: metadata, asset, time_basis: basis });
      records.push(record(key, 'vod.recording', start, end, bounds, camera, key, {
        media: [{ ...asset, media_start_seconds: 0, media_end_seconds: duration }], time_basis: basis, camera,
      })!);
    }
  }
  return result(records, evidence, 'local-files-hashed', [
    `Only ${lookback} archive day(s) before the requested interval scanned; longer overlaps may be absent.`,
    'Filesystem scan is not atomic; each selected file is checked for changes. No remote publication is inferred.',
  ], { archive_timezone: zone, scanned_directories: examined, missing_directories: missing, cameras: [...cameras].sort(compare) });
}
export function vodDatabase(bounds: Scope, path: string, directory?: string, cameras: string[] = []): Collected {
  const db = sqliteRead(path), root = directory ? expand(directory) : undefined, records: ActivityRecord[] = [];
  const evidence: { recordings: Row[]; related: Record<string, Record<string, Row[]>> } = { recordings: [], related: Object.create(null) };
  try {
    if (root && (!existsSync(root) || !statSync(root).isDirectory())) throw new Error(`Archive root missing: ${root}`);
    const tables = new Set(rows(db, "SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name));
    const selected = rows(db, 'SELECT * FROM recordings WHERE start_utc_ms < ? AND end_utc_ms > ? ORDER BY start_utc_ms,id',
      [instant(bounds.end).epochMilliseconds, instant(bounds.start).epochMilliseconds]);
    for (const r of selected) {
      if (cameras.length && !cameras.includes(r.camera_id)) continue;
      evidence.recordings.push(r);
      const related: Record<string, Row[]> = {};
      for (const table of ['recording_sources', 'recording_renditions', 'recording_assets', 'asset_timestamps']) {
        if (tables.has(table)) related[table] = rows(db, `SELECT * FROM "${table}" WHERE recording_id=?`, [r.id]).sort((a, b) => Buffer.compare(encode(a), encode(b)));
      }
      evidence.related[r.id] = related;
      const assets: Media[] = [], known = related.recording_sources?.[0] ?? {}, local = root ? safePath(root, r.source_key) : undefined;
      if (local && existsSync(local) && statSync(local).isFile()) {
        const asset = localAsset(local, root!);
        if (known.sha256 && known.sha256 !== asset.sha256) throw new Error(`VOD source hash differs from local bytes: ${r.source_key}`);
        assets.push(asset);
      } else if (known.sha256) assets.push({ sha256: known.sha256, bytes: known.size_bytes, role: 'original',
        location: { kind: 'archive-relative', path: r.source_key }, availability: 'not-checked' });
      for (const a of related.recording_renditions ?? []) {
        if (a.status === 'ready' && a.sha256) assets.push({ sha256: a.sha256, bytes: a.size_bytes, role: 'archive',
          location: { kind: 'object', bucket: a.output_bucket, key: a.output_key }, availability: 'catalog-claim-not-checked' });
      }
      records.push(record(r.id, 'vod.recording', epoch(r.start_utc_ms / 1000), epoch(r.end_utc_ms / 1000), bounds, r.camera_id, r.source_key,
        { media: assets, time_basis: 'vod-catalog', data: r, media_identity_missing: !assets.length })!);
    }
    return result(records, evidence, 'vod-sqlite-read-transaction', [
      'Retains selected catalog rows; remote availability is not checked.',
      'Originals without catalog hashes or local bytes are explicitly marked media_identity_missing.',
    ], { cameras: [...cameras].sort(compare) });
  } finally { db.close(); }
}
