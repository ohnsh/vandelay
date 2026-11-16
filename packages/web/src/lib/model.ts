import type {
  ArchiveRecord,
  Media,
  Placement,
  RecordTime,
  Scope,
} from '@vandelay/ddb/model'

export type Track =
  | 'activity'
  | 'observation'
  | 'window'
  | 'afk'
  | 'recording'
  | 'gap'
  | 'report'
  | 'other'
export interface Ref {
  source: { type: string; instance: string }
  id: string
  revision?: string
}
export interface Link {
  id: string
  label: string
  href?: string
  status: string
  revision?: string
}
export interface Detail {
  anchor: string
  text: string
  time?: RecordTime
  supports: Link[]
}
export interface Frame {
  key: string
  anchor: string
  href: string
  source: string
  recordID: string
  revision?: string
  at: string
  time: RecordTime
  disposition: string
  media?: Media
  frameIndex?: number
  presentation?: { value: string; timescale: number }
  app?: string
  session?: string
  stream?: string
  preview?: string
  previewStatus: string
}
export interface Clip {
  url: string
  label: string
  frames: { at: string; href: string; offset: number; gap: boolean; recordID: string }[]
}
export interface Entry {
  anchor: string
  href: string
  recordID: string
  source: string
  kind: string
  track: Track
  title: string
  text: string
  time: RecordTime
  placement: Placement
  category?: string
  app?: string
  apps: string[]
  attribution?: string
  details: Detail[]
  links: Link[]
  frameKeys: string[]
  clip?: Clip
  mediaStatus?: string
  recordings?: { sha256: string; bytes: number; url?: string }[]
  provenance: string
  evidence?: ArchiveRecord['evidence']
}
export interface DayView {
  scope: Scope
  sources: {
    slot: string
    count: number
    limitations: string[]
    manifest: string
    sha256: string
  }[]
  entries: Entry[]
  frames: Frame[]
}
export interface Publication {
  schema: 'vandelay.web/v1'
  commit: string
  generator: string
  inputDigest: string
  verification: { archive: string; signature: string; timestamp: string }
  days: DayView[]
}
export function at(time: RecordTime | Placement): string | undefined {
  return 'at' in time ? time.at : 'start' in time ? time.start : undefined
}
export function timeLabel(time: RecordTime | Placement, timezone: string): string {
  const start = at(time)
  if (!start) return time.model === 'day' ? 'Day-associated' : 'Time unknown'
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short',
  })
  const label = format.format(new Date(start))
  return 'end' in time && time.end !== start
    ? `${label} – ${format.format(new Date(time.end))}`
    : label
}
export function timeBasis(time: RecordTime): string {
  if (time.model === 'bounds' && time.basis === 'sample-envelope')
    return 'Sampled bounds · not time spent'
  if (time.model === 'bounds') return `Bounds · ${time.basis}`
  if (time.model === 'interval') return `Interval · ${time.basis}`
  if (time.model === 'instant') return `Instant · ${time.basis}`
  return time.model === 'day' ? 'Calendar association, not duration' : time.reason
}
export function withBase(path: string, base = import.meta.env.BASE_URL): string {
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}
