import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Temporal } from '@js-temporal/polyfill';

export { Temporal };
export type Source = 'activitywatch' | 'dayflow' | 'vod';
export interface Interval { start: string; end: string }
export interface Scope extends Interval { day: string; timezone: string }
export interface Media {
  sha256: string; bytes: number; role: string;
  location: { kind: 'archive-relative'; path: string } | { kind: 'object'; bucket: string; key: string };
  media_start_seconds?: number; media_end_seconds?: number; availability?: string;
}
export interface ActivityRecord extends Interval {
  id: string; kind: string; visible: Interval; title: string; text: string;
  media?: Media[];
  [key: string]: unknown;
}
export interface Collected {
  records: ActivityRecord[];
  evidence: unknown;
  coverage: { state: 'observed'; method: string; limitations: string[]; [key: string]: unknown };
  observations?: unknown;
}
export interface Manifest {
  schema: 'vandelay.bundle/v1'; scope: Scope; source: { type: Source; instance: string };
  producer: { name: string; version: string; adapter: string };
  coverage: Collected['coverage']; record_count: number;
  files: Record<string, { sha256: string; bytes: number }>;
}

// Compare Unicode code points (Python-compatible), not locale-dependent collation.
export function compare(a: string, b: string): number {
  const left = Array.from(a, c => c.codePointAt(0)!);
  const right = Array.from(b, c => c.codePointAt(0)!);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

// Serialize directly so JS's integer-key enumeration cannot undo lexical sorting.
export function json(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(json).join(',') + ']';
  if (typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return '{' + Object.keys(value).sort(compare).map(k => JSON.stringify(k) + ':' + json((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  throw new Error('Expected JSON data with finite numbers (no undefined, bigint, or binary values)');
}
export const encode = (value: unknown): Buffer => Buffer.from(json(value) + '\n');
export const equal = (a: unknown, b: unknown): boolean => json(a) === json(b);
export const digest = (data: Uint8Array | string): string => createHash('sha256').update(data).digest('hex');
export function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Expected a lowercase SHA-256 ID');
  return value;
}
export function expand(path: string): string {
  return resolve(path === '~' ? homedir() : path.startsWith('~/') ? join(homedir(), path.slice(2)) : path);
}
function resolvedAncestor(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(resolvedAncestor(parent), relative(parent, path));
}
export function safePath(root: string, path: string): string {
  if (!path || isAbsolute(path) || path.includes('\\') || path.split('/').some(p => !p || p === '.' || p === '..')) {
    throw new Error(`Unsafe relative path: ${path}`);
  }
  const target = resolve(root, path);
  const rel = relative(resolvedAncestor(resolve(root)), resolvedAncestor(target));
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error(`Path escapes root: ${path}`);
  return target;
}
export const instant = (value: string): Temporal.Instant => Temporal.Instant.from(value);
export const iso = (value: Temporal.Instant): string => value.toString({ fractionalSecondDigits: 6 });
export function epoch(value: number): Temporal.Instant {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid epoch: ${value}`);
  return Temporal.Instant.fromEpochNanoseconds(BigInt(Math.round(value * 1e6)) * 1000n);
}
export const seconds = (value: Temporal.Instant): number => Number(value.epochNanoseconds) / 1e9;
export function addSeconds(value: Temporal.Instant, duration: number): Temporal.Instant {
  if (!Number.isFinite(duration)) throw new Error('Invalid duration');
  return value.add({ microseconds: Math.round(duration * 1e6) });
}
export function localInstant(value: string, zone: string, fold = 'reject'): Temporal.Instant {
  if (!['reject', 'earlier', 'later'].includes(fold)) throw new Error(`Invalid fold policy: ${fold}`);
  const plain = Temporal.PlainDateTime.from(value, { overflow: 'reject' });
  const earlier = plain.toZonedDateTime(zone, { disambiguation: 'earlier' });
  const later = plain.toZonedDateTime(zone, { disambiguation: 'later' });
  if (!earlier.toPlainDateTime().equals(plain) || !later.toPlainDateTime().equals(plain)) throw new Error(`Nonexistent local time: ${value} ${zone}; supply startUtc`);
  if (fold === 'reject' && !earlier.equals(later)) throw new Error(`Ambiguous local time: ${value} ${zone}; supply fold or startUtc`);
  return (fold === 'later' ? later : earlier).toInstant();
}
export function scope(day: string, zone: string): Scope {
  const date = Temporal.PlainDate.from(day);
  if (date.toString() !== day) throw new Error('Day must be YYYY-MM-DD');
  const start = date.toZonedDateTime(zone).toInstant();
  const end = date.add({ days: 1 }).toZonedDateTime(zone).toInstant();
  if (Temporal.Instant.compare(end, start) <= 0) throw new Error('This calendar day has no duration');
  return { day, timezone: zone, start: iso(start), end: iso(end) };
}
export function clip(start: Temporal.Instant, end: Temporal.Instant, bounds: Scope): Interval | null {
  const lo = instant(bounds.start), hi = instant(bounds.end), cmp = Temporal.Instant.compare;
  if (cmp(end, start) < 0) throw new Error('Negative interval');
  if (cmp(start, end) === 0) return cmp(lo, start) <= 0 && cmp(start, hi) < 0 ? { start: iso(start), end: iso(end) } : null;
  if (cmp(end, lo) <= 0 || cmp(start, hi) >= 0) return null;
  return { start: iso(cmp(start, lo) > 0 ? start : lo), end: iso(cmp(end, hi) < 0 ? end : hi) };
}
export function record(id: string | number, kind: string, start: Temporal.Instant, end: Temporal.Instant, bounds: Scope,
  title = '', text = '', extra: Record<string, unknown> = {}): ActivityRecord | null {
  const visible = clip(start, end, bounds);
  return visible ? { id: String(id), kind, start: iso(start), end: iso(end), visible, title, text, ...extra } : null;
}
export function fileHash(path: string): string {
  const h = createHash('sha256'), buffer = Buffer.allocUnsafe(4 * 1024 * 1024), fd = openSync(path, 'r');
  try { let count; while ((count = readSync(fd, buffer)) > 0) h.update(buffer.subarray(0, count)); }
  finally { closeSync(fd); }
  return h.digest('hex');
}
