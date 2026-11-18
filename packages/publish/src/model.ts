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
  target?: Ref
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
  playback?: { asset: string; offset: number; duration: number }
}
export interface Clip {
  label: string
  /** Ordered capture identities; playback locations live on the shared frames. */
  frameKeys: string[]
  selection: 'day' | 'activity-time-range'
}
export interface Entry {
  status: 'active' | 'withheld'
  anchor: string
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
  schema: 'vandelay.publish.day/v1'
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
  timelapses: { source: string; stream?: string; clip: Clip }[]
}
export interface Publication {
  schema: 'vandelay.publish/v1'
  commit: string
  generator: string
  generatorDigest: string
  configuration: { media: 'all' | 'none'; captureStride: number; sources?: string[];
    redaction?: { reportSha256: string; reviewSha256: string; recipe: string } }
  inputDigest: string
  verification: { archive: string; signature: string; timestamp: string }
  days: DayView[]
}
export interface ObjectRef { path: string; sha256: string; bytes: number }
export interface PlaybackManifest {
  schema: 'vandelay.publish.playback/v1'
  /** Capture minute changes keyed by elapsed montage seconds; never interpolate across gaps. */
  clock?: { elapsed: number; at: string }[]
  ranges: { url: string; start: number; end: number }[]
}
export interface DailyPreview {
  schema: 'vandelay.publish.preview/v1'
  scope: Scope
  highlights: { anchor: string; at: string; title: string; summary: string }[]
  timelapses: { source: string; stream?: string; label: string; poster?: string; playback: ObjectRef }[]
}
export interface Asset extends ObjectRef {
  mediaType: 'video/mp4' | 'image/webp'
  recipe: string
  inputs: { sha256: string; frameIndex?: number; presentation?: Frame['presentation']; outputFrame?: number }[]
}
export interface PublicationManifest extends Omit<Publication, 'days'> {
  days: { scope: Scope; object: ObjectRef; preview?: ObjectRef }[]
}
export interface Current {
  schema: 'vandelay.publish.current/v1'
  manifest: ObjectRef
}
/** Public artifacts omit local archive paths; only the preparation pipeline uses them. */
export type PublishedFrame = Omit<Frame, 'media'> & {
  media?: Omit<Media, 'location'>
}
export type PublishedDay = Omit<DayView, 'frames'> & { frames: PublishedFrame[]; assets: Asset[] }
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
