import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, readSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Temporal } from '@js-temporal/polyfill'

export { Temporal }
export type Source = 'activitywatch' | 'dayflow' | 'daycap' | 'vod'
export interface Interval {
  start: string
  end: string
}
export interface Scope extends Interval {
  day: string
  timezone: string
}
export interface Media {
  sha256: string
  bytes: number
  role: string
  location:
    | { kind: 'archive-relative'; path: string }
    | { kind: 'object'; bucket: string; key: string }
  media_start_seconds?: number
  media_end_seconds?: number
  availability?: string
  selector?: {
    type: 'video-frame'
    frame_index: number
    presentation: { value: string; timescale: number }
  }
}
export interface DayAssociation {
  day: string
  timezone: string
  role: string // e.g. report-day, source-day, or archive-association
}
/** Time shape and its evidentiary basis are separate: an interval need not be measured work. */
export type RecordTime =
  | { model: 'instant'; at: string; basis: string }
  | { model: 'interval'; start: string; end: string; basis: string }
  | { model: 'bounds'; start: string; end: string; basis: string }
  | { model: 'day'; associations: DayAssociation[] }
  | { model: 'unknown'; reason: string; associations: DayAssociation[] }
export type Placement =
  | { model: 'instant'; at: string }
  | { model: 'interval' | 'bounds'; start: string; end: string }
  | { model: 'day' | 'unknown'; roles: string[] }
export interface RecordContent {
  id: string
  kind: string
  title?: string
  text?: string
  media?: Media[]
  evidence?: Record<string, unknown>
  interpretation?: 'source-generated' | 'source-reported' | 'adapter-derived' | 'human-authored'
  data?: unknown
  attributes?: Record<string, unknown>
}
export interface ArchiveRecord extends RecordContent {
  schema: 'vandelay.record/v1'
  time: RecordTime
  /** Derived membership/display projection in the enclosing bundle's day scope. */
  placement: Placement
}
export type RecordInput = RecordContent & { time: RecordTime }
export interface Collected {
  records: ArchiveRecord[]
  evidence: unknown
  /** Exact source bytes, when reserialization would discard source evidence. */
  evidenceBytes?: Buffer
  coverage: {
    state: 'observed'
    method: string
    limitations: string[]
    [key: string]: unknown
  }
  observations?: unknown
}
export interface Manifest {
  schema: 'vandelay.bundle/v1'
  record_schema: 'vandelay.record/v1'
  scope: Scope
  source: { type: Source; instance: string }
  producer: { name: string; version: string; adapter: string }
  coverage: Collected['coverage']
  record_count: number
  files: Record<string, { sha256: string; bytes: number }>
}

// Compare Unicode code points (Python-compatible), not locale-dependent collation.
export function compare(a: string, b: string): number {
  const left = Array.from(a, (c) => c.codePointAt(0)!)
  const right = Array.from(b, (c) => c.codePointAt(0)!)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i]
  }
  return left.length - right.length
}

// Serialize directly so JS's integer-key enumeration cannot undo lexical sorting.
export function json(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(json).join(',') + ']'
  if (
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return (
      '{' +
      Object.keys(value)
        .sort(compare)
        .map((k) => JSON.stringify(k) + ':' + json((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    )
  }
  throw new Error(
    'Expected JSON data with finite numbers (no undefined, bigint, or binary values)',
  )
}
export const encode = (value: unknown): Buffer => Buffer.from(json(value) + '\n')
export const equal = (a: unknown, b: unknown): boolean => json(a) === json(b)
export const digest = (data: Uint8Array | string): string =>
  createHash('sha256').update(data).digest('hex')
export function identifier(value: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value))
    throw new Error('Expected a lowercase SHA-256 ID')
  return value
}
export function expand(path: string): string {
  return resolve(
    path === '~'
      ? homedir()
      : path.startsWith('~/')
        ? join(homedir(), path.slice(2))
        : path,
  )
}
function resolvedAncestor(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  if (parent === path) return path
  return join(resolvedAncestor(parent), relative(parent, path))
}
export function safePath(root: string, path: string): string {
  if (
    !path ||
    isAbsolute(path) ||
    path.includes('\\') ||
    path.split('/').some((p) => !p || p === '.' || p === '..')
  ) {
    throw new Error(`Unsafe relative path: ${path}`)
  }
  const target = resolve(root, path)
  const rel = relative(resolvedAncestor(resolve(root)), resolvedAncestor(target))
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error(`Path escapes root: ${path}`)
  return target
}
export const instant = (value: string): Temporal.Instant => Temporal.Instant.from(value)
export const iso = (value: Temporal.Instant): string =>
  value.toString({ fractionalSecondDigits: 6 })
export function epoch(value: number): Temporal.Instant {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`Invalid epoch: ${value}`)
  return Temporal.Instant.fromEpochNanoseconds(BigInt(Math.round(value * 1e6)) * 1000n)
}
export const seconds = (value: Temporal.Instant): number =>
  Number(value.epochNanoseconds) / 1e9
export function addSeconds(value: Temporal.Instant, duration: number): Temporal.Instant {
  if (!Number.isFinite(duration)) throw new Error('Invalid duration')
  return value.add({ microseconds: Math.round(duration * 1e6) })
}
export function localInstant(
  value: string,
  zone: string,
  fold = 'reject',
): Temporal.Instant {
  if (!['reject', 'earlier', 'later'].includes(fold))
    throw new Error(`Invalid fold policy: ${fold}`)
  const plain = Temporal.PlainDateTime.from(value, { overflow: 'reject' })
  const earlier = plain.toZonedDateTime(zone, { disambiguation: 'earlier' })
  const later = plain.toZonedDateTime(zone, { disambiguation: 'later' })
  if (!earlier.toPlainDateTime().equals(plain) || !later.toPlainDateTime().equals(plain))
    throw new Error(`Nonexistent local time: ${value} ${zone}; supply startUtc`)
  if (fold === 'reject' && !earlier.equals(later))
    throw new Error(`Ambiguous local time: ${value} ${zone}; supply fold or startUtc`)
  return (fold === 'later' ? later : earlier).toInstant()
}
export function scope(day: string, zone: string): Scope {
  const date = Temporal.PlainDate.from(day)
  if (date.toString() !== day) throw new Error('Day must be YYYY-MM-DD')
  const start = date.toZonedDateTime(zone).toInstant()
  const end = date.add({ days: 1 }).toZonedDateTime(zone).toInstant()
  if (Temporal.Instant.compare(end, start) <= 0)
    throw new Error('This calendar day has no duration')
  return { day, timezone: zone, start: iso(start), end: iso(end) }
}
export function clip(
  start: Temporal.Instant,
  end: Temporal.Instant,
  bounds: Scope,
): Interval | null {
  const lo = instant(bounds.start),
    hi = instant(bounds.end),
    cmp = Temporal.Instant.compare
  if (cmp(end, start) < 0) throw new Error('Negative interval')
  if (cmp(start, end) === 0)
    return cmp(lo, start) <= 0 && cmp(start, hi) < 0
      ? { start: iso(start), end: iso(end) }
      : null
  if (cmp(end, lo) <= 0 || cmp(start, hi) >= 0) return null
  return {
    start: iso(cmp(start, lo) > 0 ? start : lo),
    end: iso(cmp(end, hi) < 0 ? end : hi),
  }
}
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object')
}
function nonempty(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonempty string')
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key)))
    throw new Error('Unexpected field')
}
function timestamp(value: unknown): string {
  nonempty(value)
  const parsed = instant(value)
  if (parsed.epochNanoseconds % 1000n !== 0n)
    throw new Error('Timestamps must have at most microsecond precision')
  return iso(parsed)
}
/** Validate and normalize the union at runtime as well as in TypeScript. */
export function normalizeTime(value: unknown): RecordTime {
  object(value)
  switch (value.model) {
    case 'instant':
      keys(value, ['model', 'at', 'basis'])
      nonempty(value.basis)
      return { model: 'instant', at: timestamp(value.at), basis: value.basis }
    case 'interval':
    case 'bounds': {
      keys(value, ['model', 'start', 'end', 'basis'])
      nonempty(value.basis)
      const start = timestamp(value.start), end = timestamp(value.end)
      const order = Temporal.Instant.compare(instant(start), instant(end))
      if (order > 0 || (order === 0 && value.model === 'interval'))
        throw new Error('Interval must have positive duration; bounds may be equal')
      return { model: value.model, start, end, basis: value.basis }
    }
    case 'day':
    case 'unknown': {
      keys(value, value.model === 'day' ? ['model', 'associations'] : ['model', 'reason', 'associations'])
      if (!Array.isArray(value.associations) || !value.associations.length)
        throw new Error('Day membership requires explicit associations')
      const associations = value.associations.map(item => {
        object(item)
        keys(item, ['day', 'timezone', 'role'])
        nonempty(item.day); nonempty(item.timezone); nonempty(item.role)
        scope(item.day, item.timezone)
        return { day: item.day, timezone: item.timezone, role: item.role }
      }).sort((a, b) => compare(a.day, b.day) || compare(a.timezone, b.timezone) || compare(a.role, b.role))
      if (new Set(associations.map(json)).size !== associations.length)
        throw new Error('Duplicate day association')
      if (value.model === 'day') return { model: 'day', associations }
      nonempty(value.reason)
      return { model: 'unknown', reason: value.reason, associations }
    }
    default: throw new Error('Unknown time model')
  }
}
export function placement(time: RecordTime, bounds: Scope): Placement | null {
  switch (time.model) {
    case 'instant':
      return clip(instant(time.at), instant(time.at), bounds)
        ? { model: 'instant', at: time.at } : null
    case 'interval':
    case 'bounds': {
      const visible = clip(instant(time.start), instant(time.end), bounds)
      return visible ? { model: time.model, ...visible } : null
    }
    case 'day':
    case 'unknown': {
      // Calendar associations are not inferred instants in another timezone.
      const roles = time.associations.filter(a => a.day === bounds.day && a.timezone === bounds.timezone)
        .map(a => a.role).sort(compare)
      return roles.length ? { model: time.model, roles } : null
    }
  }
}
/** Optional convenience for sources whose zero-duration intervals represent points. */
export function intervalTime(start: Temporal.Instant, end: Temporal.Instant, basis: string): RecordTime {
  return Temporal.Instant.compare(start, end) === 0
    ? { model: 'instant', at: iso(start), basis }
    : { model: 'interval', start: iso(start), end: iso(end), basis }
}
function content(value: Record<string, unknown>) {
  nonempty(value.id); nonempty(value.kind)
  for (const key of ['title', 'text'])
    if (value[key] !== undefined && typeof value[key] !== 'string')
      throw new Error(`Invalid ${key}`)
  for (const key of ['evidence', 'attributes'])
    if (value[key] !== undefined) object(value[key])
  if (value.media !== undefined && !Array.isArray(value.media)) throw new Error('Invalid media')
  if (value.interpretation !== undefined &&
      !['source-generated', 'source-reported', 'adapter-derived', 'human-authored'].includes(value.interpretation as string))
    throw new Error('Invalid interpretation')
}
const contentKeys = ['id', 'kind', 'title', 'text', 'media', 'evidence', 'interpretation', 'data', 'attributes']
export function record(input: RecordInput, bounds: Scope): ArchiveRecord | null {
  object(input)
  keys(input, [...contentKeys, 'time'])
  content(input)
  const time = normalizeTime(input.time)
  const selected = placement(time, bounds)
  return selected ? { ...input, schema: 'vandelay.record/v1', time, placement: selected } : null
}
/** Reject malformed JSONL, including fabricated clipping and ambiguous old fields. */
export function validateRecord(value: unknown, bounds: Scope): asserts value is ArchiveRecord {
  object(value)
  keys(value, [...contentKeys, 'schema', 'time', 'placement'])
  if (value.schema !== 'vandelay.record/v1') throw new Error('Unsupported record schema')
  content(value)
  const time = normalizeTime(value.time)
  const selected = placement(time, bounds)
  if (!equal(time, value.time) || !selected || !equal(selected, value.placement))
    throw new Error('Invalid record time or day placement')
}
/** Day-associated/undated records follow timed records, without invented midnight times. */
export function compareRecords(a: ArchiveRecord, b: ArchiveRecord): number {
  const key = (r: ArchiveRecord): string => {
    switch (r.time.model) {
      case 'instant': return `0:${r.time.at}`
      case 'interval':
      case 'bounds': return `0:${r.time.start}`
      case 'day': return '1'
      case 'unknown': return '2'
    }
  }
  return compare(key(a), key(b)) || compare(a.kind, b.kind) || compare(a.id, b.id)
}
export function fileHash(path: string): string {
  const h = createHash('sha256'),
    buffer = Buffer.allocUnsafe(4 * 1024 * 1024),
    fd = openSync(path, 'r')
  try {
    let count
    while ((count = readSync(fd, buffer)) > 0) h.update(buffer.subarray(0, count))
  } finally {
    closeSync(fd)
  }
  return h.digest('hex')
}
