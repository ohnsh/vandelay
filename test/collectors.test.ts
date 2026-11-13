// Collector regression cases adapted from ../vandelay/test/archive.test.ts.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as collectors from '../src/collectors.ts';
import { digest, encode, instant, iso, localInstant, record, scope, seconds } from '../src/model.ts';

let root: string;
const bounds = scope('2026-11-10', 'America/Chicago');
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'did-collectors-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));
function write(path: string, bytes: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); }

test('DST, midnight membership, microseconds and deterministic JSON', () => {
  for (const [date, hours] of [['2026-03-08', 23], ['2026-11-01', 25]] as const) {
    const b = scope(date, 'America/Chicago');
    expect(seconds(instant(b.end)) - seconds(instant(b.start))).toBe(hours * 3600);
  }
  expect(record('a', 'test', instant(bounds.end), instant(bounds.end), bounds)).toBeNull();
  expect(iso(instant('2026-11-10T06:00:00.123456Z'))).toBe('2026-11-10T06:00:00.123456Z');
  expect(() => localInstant('2026-11-01T01:30:00', bounds.timezone)).toThrow('Ambiguous');
  expect(() => localInstant('2026-03-08T02:30:00', bounds.timezone, 'later')).toThrow('Nonexistent');
  expect(encode({ 2: 'two', 10: 'ten' }).toString()).toBe('{"10":"ten","2":"two"}\n');
  expect(() => encode({ x: NaN })).toThrow();
});

test('AW retains overlaps, scopes hosts and excludes volatile bucket update times', async () => {
  const path = join(root, 'aw.json'), snapshot = { buckets: { window: { hostname: 'mac', type: 'window', last_updated: 'first', events: [
    { id: 1, timestamp: '2026-11-10T05:59:00Z', duration: 120, data: { app: 'Editor' } },
    { id: 2, timestamp: bounds.end, duration: 0, data: {} },
  ] } } };
  write(path, encode(snapshot));
  const first = await collectors.activitywatch(bounds, 'mac', undefined, path);
  expect(first.records).toHaveLength(1);
  expect(first.records[0].visible.start).toBe(bounds.start);
  snapshot.buckets.window.last_updated = 'second'; write(path, encode(snapshot));
  const second = await collectors.activitywatch(bounds, 'mac', undefined, path);
  expect(second.evidence).toEqual(first.evidence);
  expect(second.records).toEqual(first.records);
  await expect(collectors.activitywatch(bounds, 'missing', undefined, path)).rejects.toThrow('No ActivityWatch');
});

test('AW HTTP queries preserve overlaps and propagate server failures', async () => {
  const server = Bun.serve({ port: 0, fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/api/0/buckets/') return Response.json({ b: { hostname: 'mac', type: 'window' } });
    expect(url.searchParams.get('start')).toBeNull();
    expect(url.searchParams.get('limit')).toBe('-1');
    return new Response('error', { status: 503 });
  } });
  try { await expect(collectors.activitywatch(bounds, 'mac', server.url.toString())).rejects.toThrow('503'); }
  finally { server.stop(true); }
});

test('Dayflow reads WAL, preserves deleted evidence and includes next-day reports', () => {
  const path = join(root, 'dayflow.db'), db = new Database(path);
  db.run(`PRAGMA journal_mode=WAL;
    CREATE TABLE timeline_cards(id INTEGER, start_ts REAL, end_ts REAL, title TEXT, summary TEXT, is_deleted INTEGER);
    CREATE TABLE observations(id INTEGER, start_ts REAL, end_ts REAL, observation TEXT);
    CREATE TABLE daily_standup_entries(id INTEGER, standup_day TEXT, payload_json TEXT);`);
  const start = seconds(instant(bounds.start));
  db.run('INSERT INTO timeline_cards VALUES (?,?,?,?,?,?)', [1, start-60, start+60, 'card', 'text', 0]);
  db.run('INSERT INTO timeline_cards VALUES (?,?,?,?,?,?)', [2, start, start+60, 'deleted', '', 1]);
  db.run('INSERT INTO observations VALUES (?,?,?,?)', [1, start, start, 'point']);
  db.run('INSERT INTO daily_standup_entries VALUES (?,?,?)', [1, '2026-11-11', JSON.stringify({ generation: { sourceDay: bounds.day } })]);
  try {
    const data = collectors.dayflow(bounds, path);
    expect(data.records).toHaveLength(3);
    expect((data.evidence as { timeline_cards: unknown[] }).timeline_cards).toHaveLength(2);
    expect(db.query('SELECT count(*) AS n FROM timeline_cards').get()).toEqual({ n: 2 });
  } finally { db.close(); }
});

test('VOD filesystem retains midnight overlaps, media hashes and timelapse durations', () => {
  const media = join(root, 'media'), path = join(media, '2026-11/09/_cam/cam_20261109_235900.mp4');
  write(path, 'media bytes');
  const data = collectors.vodFiles(bounds, media, { timezone: bounds.timezone, sources: { cam: { mode: 'timelapse', wallDurationSeconds: 120 } } }, [], 1, () => ({ format: { duration: '2' } }));
  expect(data.records).toHaveLength(1);
  expect(data.records[0].visible.start).toBe(bounds.start);
  expect(data.records[0].media?.[0].sha256).toBe(digest('media bytes'));
  expect(data.records[0].media?.[0].media_end_seconds).toBe(2);
  expect(() => collectors.vodFiles(bounds, media, { timezone: bounds.timezone }, [], 1, file => {
    write(file, 'modified'); return { format: { duration: '120' } };
  })).toThrow('changed during probing');
});

test('Dayflow archives frames, preserves batch inputs, and retains immutable revisions', () => {
  const source = join(root, 'Dayflow'), archive = join(root, 'archive');
  mkdirSync(source);
  const path = join(source, 'chunks.sqlite'), db = new Database(path);
  const video = join(source, 'recordings', 'segment.mp4'), pending = join(source, 'recordings', 'pending.mp4');
  write(video, 'original'); write(pending, 'unfinished');
  db.run(`CREATE TABLE timeline_cards(id INTEGER, batch_id INTEGER, start_ts INTEGER, end_ts INTEGER);
    CREATE TABLE observations(id INTEGER, batch_id INTEGER, start_ts INTEGER, end_ts INTEGER);
    CREATE TABLE daily_standup_entries(standup_day TEXT, payload_json TEXT);
    CREATE TABLE screenshots(id INTEGER, captured_at INTEGER, file_path TEXT, frame_index INTEGER, file_size INTEGER, idle_seconds_at_capture INTEGER);
    CREATE TABLE batch_screenshots(batch_id INTEGER, screenshot_id INTEGER);
    CREATE TABLE analysis_batches(id INTEGER, status TEXT);`);
  const start = seconds(instant(bounds.start)), end = seconds(instant(bounds.end));
  db.run('INSERT INTO observations VALUES (1,7,?,?)', [start, start+10]);
  db.run("INSERT INTO analysis_batches VALUES (7,'complete'),(8,'complete'),(9,'complete')");
  for (const [id, time, file, index, size] of [
    [1, start, video, 0, 8], [2, start+5, video, 1, 8], [3, start-5, video, 2, 8],
    [4, start+10, pending, 0, null], [5, start+15, join(source, 'gone.mp4'), 0, 8],
    [6, end, video, 3, 8],
  ] as const) db.run('INSERT INTO screenshots VALUES (?,?,?,?,?,42)', [id, time, file, index, size]);
  db.run('INSERT INTO batch_screenshots VALUES (8,1),(7,1),(7,3),(9,6)');
  try {
    const first = collectors.dayflow(bounds, path, archive), evidence = first.evidence as any;
    expect(first.records.filter(r => r.kind === 'dayflow.screenshots')).toHaveLength(4);
    expect(evidence.screenshots).toHaveLength(6);
    expect(evidence.batch_screenshots).toHaveLength(4);
    expect(evidence.analysis_batches.map((r: any) => r.id)).toEqual([7, 8, 9]);
    expect(evidence.screenshots.find((r: any) => r.id === 6).batch_ids).toEqual([9]);
    expect(first.records.some(r => r.id === 'screenshots:6')).toBe(false);
    expect((first.records.find(r => r.id === 'screenshots:1')!.data as any).batch_ids).toEqual([7, 8]);
    expect((first.records.find(r => r.id === 'screenshots:2')!.data as any).batch_ids).toEqual([]);
    const frame = evidence.screenshots.find((r: any) => r.id === 1);
    expect(frame.file_path).toBeUndefined();
    expect(frame.batch_ids).toEqual([7, 8]);
    expect(frame.idle_seconds_at_capture).toBe(42);
    expect(frame.media.sha256).toBe(digest('original'));
    const oldPath = join(archive, frame.media.location.path);
    expect(readFileSync(oldPath, 'utf8')).toBe('original');
    expect(evidence.screenshots.find((r: any) => r.id === 4).media.availability).toBe('pending-finalization');
    expect(evidence.screenshots.find((r: any) => r.id === 5).media.availability).toBe('missing');
    expect(collectors.dayflow(bounds, path, archive)).toEqual(first);
    write(video, 'changed');
    const second = collectors.dayflow(bounds, path, archive).evidence as any;
    expect(second.screenshots.find((r: any) => r.id === 1).media.sha256).toBe(digest('changed'));
    expect(readFileSync(oldPath, 'utf8')).toBe('original');
    write(join(archive, second.screenshots.find((r: any) => r.id === 1).media.location.path), 'corrupt');
    expect(() => collectors.dayflow(bounds, path, archive)).toThrow('Corrupt archive object');
    expect(() => collectors.dayflow(bounds, path, join(source, 'archive'))).toThrow('outside the Dayflow');
    const git = join(root, 'git'); mkdirSync(join(git, '.git'), { recursive: true });
    expect(() => collectors.dayflow(bounds, path, join(git, 'archive'))).toThrow('outside Git');
    expect(existsSync(pending)).toBe(true);
  } finally { db.close(); }
});

test('VOD catalog hashes are claims until local bytes are checked; unsafe integers fail', () => {
  const path = join(root, 'vod.db'), db = new Database(path), start = instant(bounds.start).epochMilliseconds;
  db.run(`CREATE TABLE recordings(id INTEGER, camera_id TEXT, source_key TEXT, start_utc_ms INTEGER, end_utc_ms INTEGER);
    CREATE TABLE recording_sources(recording_id INTEGER, sha256 TEXT, size_bytes INTEGER);`);
  db.run('INSERT INTO recordings VALUES (?,?,?,?,?)', [1, 'cam', '2026-11/10/_cam/00.mp4', start-1000, start+1000]);
  db.run('INSERT INTO recording_sources VALUES (?,?,?)', [1, digest('x'), 1]);
  const data = collectors.vodDatabase(bounds, path);
  expect(data.records[0].media?.[0].availability).toBe('not-checked');
  const media = join(root, 'media'); write(join(media, '2026-11/10/_cam/00.mp4'), 'wrong');
  expect(() => collectors.vodDatabase(bounds, path, media)).toThrow('hash differs');
  db.run('INSERT INTO recordings VALUES (?,?,?,?,?)', [9223372036854775807n, 'cam', 'x', start, start+1000]);
  db.close();
  expect(() => collectors.vodDatabase(bounds, path)).toThrow('safe range');
});
