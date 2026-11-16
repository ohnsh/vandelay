import { compare, digest, type ArchiveRecord, type Manifest } from '@vandelay/ddb/model'
import {
  at,
  type DayView,
  type Entry,
  type Frame,
  type Link,
  type Ref,
  type Track,
} from './model'

// Source payloads are adapter-owned. These accessors keep opaque extensions out of the public projection.
type ObjectValue = Record<string, any>
const obj = (value: unknown): ObjectValue =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as ObjectValue)
    : {}
const text = (value: unknown): string => (typeof value === 'string' ? value : '')
export const identity = (source: string, id: string) => JSON.stringify([source, id])
export const anchor = (source: string, id: string) => `r-${digest(identity(source, id))}`
export const refKey = (ref: Ref) =>
  JSON.stringify([ref.source.type, ref.source.instance, ref.id, ref.revision ?? null])
export interface Bundle {
  manifest: Manifest
  path: string
  sha256: string
  records: ArchiveRecord[]
  evidence: unknown
  references?: {
    entries: { target: Ref; resolution: { status: string; reason?: string } }[]
  }
}
function pointer(root: unknown, path: unknown): ObjectValue {
  if (typeof path !== 'string' || !path.startsWith('/')) return {}
  let value: any = root
  for (const part of path.slice(1).split('/'))
    value = value?.[part.replace(/~1/g, '/').replace(/~0/g, '~')]
  return obj(value)
}
function track(kind: string): Track {
  if (kind.endsWith('.activity') || kind.endsWith('.timeline_cards')) return 'activity'
  if (kind.endsWith('.observation') || kind.endsWith('.observations'))
    return 'observation'
  if (kind === 'activitywatch.currentwindow') return 'window'
  if (kind === 'activitywatch.afkstatus') return 'afk'
  if (kind.endsWith('.recording')) return 'recording'
  if (kind.endsWith('.gap')) return 'gap'
  if (kind.endsWith('.report')) return 'report'
  return 'other'
}
function takeEvenly<T>(values: T[], maximum: number): T[] {
  if (values.length <= maximum) return values
  return Array.from(
    { length: maximum },
    (_, i) => values[Math.round((i * (values.length - 1)) / (maximum - 1))],
  )
}
export function projectDay(bundles: Bundle[], scope: DayView['scope']): DayView {
  const day: DayView = {
    scope,
    entries: [],
    frames: [],
    sources: bundles.map((b) => ({
      slot: `${b.manifest.source.type}/${b.manifest.source.instance}`,
      count: b.records.length,
      limitations: b.manifest.coverage.limitations,
      manifest: b.path,
      sha256: b.sha256,
    })),
  }
  const recordMap = new Map<string, { record: ArchiveRecord; href: string }>()
  for (const b of bundles) {
    const slot = `${b.manifest.source.type}/${b.manifest.source.instance}`
    const captures = b.records.filter((r) =>
      ['daycap.capture', 'dayflow.screenshots'].includes(r.kind),
    )
    for (const [i, r] of captures.entries()) {
      const d = obj(r.data),
        capture = obj(d.capture),
        original = pointer(b.evidence, r.evidence?.pointer)
      const state = obj(original.applicationState)
      const media = r.media?.[0]
      const withheld =
        d.status === 'withdrawn' ||
        d.status === 'superseded' ||
        (capture.disposition && capture.disposition !== 'captured')
      const frameIndex =
        media?.selector?.frame_index ??
        (Number.isSafeInteger(d.frame_index) && d.frame_index >= 0
          ? d.frame_index
          : undefined)
      const id = anchor(slot, r.id)
      const f: Frame = {
        key: identity(slot, r.id),
        anchor: id,
        source: slot,
        recordID: r.id,
        href: `/frames/${scope.day}/${slot}/${Math.floor(i / 100) + 1}/#${id}`,
        at: at(r.time)!,
        time: r.time,
        revision: d.revision,
        disposition: withheld
          ? text(d.status) || text(capture.disposition)
          : text(capture.disposition) || 'captured',
        media: withheld ? undefined : media,
        frameIndex,
        presentation:
          media?.selector?.presentation ??
          (frameIndex === undefined
            ? undefined
            : { value: String(frameIndex), timescale: 1 }),
        app:
          !withheld && state.foregroundChanged === false
            ? text(obj(state.foregroundBefore).name)
            : undefined,
        session: capture.session_id,
        stream: capture.stream_id ?? capture.display_id,
        previewStatus: withheld
          ? text(d.status) || text(capture.disposition)
          : media
            ? 'not prepared'
            : text(obj(d.media).availability) ||
              text(capture.disposition) ||
              'unavailable',
      }
      day.frames.push(f)
      recordMap.set(identity(slot, r.id), { record: r, href: f.href })
    }
    for (const r of b.records) {
      const key = identity(slot, r.id)
      if (!recordMap.has(key))
        recordMap.set(key, {
          record: r,
          href: `/days/${scope.day}/#${anchor(slot, r.id)}`,
        })
    }
  }
  const frames = new Map(day.frames.map((f) => [f.key, f]))
  for (const b of bundles) {
    const slot = `${b.manifest.source.type}/${b.manifest.source.instance}`
    const resolution = new Map(
      b.references?.entries.map((e) => [refKey(e.target), e.resolution]) ?? [],
    )
    const resolve = (ref: Ref): Link => {
      const source = `${ref.source.type}/${ref.source.instance}`
      const found = recordMap.get(identity(source, ref.id))
      const exact =
        found &&
        (ref.revision === undefined || obj(found.record.data).revision === ref.revision)
      const state = resolution.get(refKey(ref))
      return {
        id: identity(source, ref.id),
        label: ref.id,
        revision: ref.revision,
        href: exact ? found.href : undefined,
        status: exact
          ? 'included'
          : [state?.status ?? 'unavailable', state?.reason].filter(Boolean).join(' · '),
      }
    }
    for (const r of b.records) {
      if (frames.has(identity(slot, r.id))) continue
      const d = obj(r.data)
      const hidden = d.status === 'withdrawn' || d.status === 'superseded' || d.is_deleted
      const e: Entry = {
        anchor: anchor(slot, r.id),
        href: recordMap.get(identity(slot, r.id))!.href,
        recordID: r.id,
        source: slot,
        kind: r.kind,
        track: track(r.kind),
        title: hidden
          ? `${d.status || 'Deleted'} record`
          : r.title || r.kind.split('.').at(-1)!,
        text: hidden ? '' : r.text || '',
        time: r.time,
        placement: r.placement,
        apps: [],
        details: [],
        links: [],
        frameKeys: [],
        evidence: r.evidence,
        provenance: `${slot} · ${r.interpretation ?? 'source record'}`,
      }
      if (!hidden) {
        e.category = text(d.category) || undefined
        e.app = text(d.app) || undefined
        const relations = Array.isArray(d.relations) ? d.relations : []
        e.links = relations
          .filter((x) => ['continues', 'generated-by'].includes(x.relation))
          .map((x) => ({ ...resolve(x.target), label: `${x.relation}: ${x.target.id}` }))
        if (
          r.kind === 'daycap.journal.activity' ||
          r.kind === 'daycap.evidence.activity'
        ) {
          e.attribution =
            'Explicit sample citations; current media may differ from the historical model input.'
          e.details = (d.details ?? []).map((detail: ObjectValue) => ({
            anchor: `${e.anchor}-d-${digest(String(detail.id))}`,
            text: text(detail.text),
            time: detail.time,
            supports: (detail.supports ?? []).map(resolve),
          }))
          // Citation navigation pins revisions. Playback deliberately uses current retained capture renditions.
          const refs: Ref[] = relations
            .filter((x) => x.relation === 'supports')
            .map((x) => x.target)
          e.frameKeys = [
            ...new Set(
              refs.map((ref) =>
                identity(`${ref.source.type}/${ref.source.instance}`, ref.id),
              ),
            ),
          ].filter((key) => frames.has(key))
          e.apps = [
            ...new Set(
              e.frameKeys
                .map((key) => frames.get(key)?.app)
                .filter((a): a is string => !!a),
            ),
          ]
        } else if (r.kind === 'dayflow.timeline_cards') {
          e.text = text(d.summary) || e.text
          e.attribution =
            'Source batch association only; no exact frame citations. Preview frames are selected by time, not asserted as model inputs. Detail times are source prose.'
          if (d.detailed_summary)
            e.details = [
              {
                anchor: `${e.anchor}-details`,
                text: text(d.detailed_summary),
                supports: [],
              },
            ]
          const start = at(r.placement)!,
            end = 'end' in r.placement ? r.placement.end : start
          const selected = b.records.filter((c) => {
            const t = at(c.time)
            return c.kind === 'dayflow.screenshots' && t && t >= start && t < end
          })
          e.frameKeys = takeEvenly(selected, 12).map((c) => identity(slot, c.id))
        } else if (e.track === 'observation') {
          e.attribution = slot.startsWith('dayflow/')
            ? 'Batch association only; no exact frame citations.'
            : 'Source-generated observation'
          e.links.push(
            ...relations
              .filter((x) => x.relation === 'supports')
              .map((x) => resolve(x.target)),
          )
        } else if (e.track === 'window') {
          e.text = [text(d.title), text(d.url)].filter(Boolean).join('\n')
        } else if (e.track === 'afk') e.title = `AFK status: ${text(d.status)}`
        else if (e.track === 'gap')
          e.text = text(d.reason) || text(obj(d.capture).reason) || e.text
        if (e.track === 'recording') {
          e.recordings = r.media?.map((m) => ({ sha256: m.sha256, bytes: m.bytes }))
          e.mediaStatus =
            'Original recording referenced in archive; no web rendition configured.'
        }
        if (d.unresolved_context?.length)
          e.links.push({
            id: `${e.anchor}/context`,
            label: 'Prior context',
            status: 'generation not established',
          })
      }
      day.entries.push(e)
    }
  }
  day.entries.sort((a, b) => {
    const left = at(a.placement),
      right = at(b.placement)
    return (
      (left && right ? compare(left, right) : left ? -1 : right ? 1 : 0) ||
      compare(a.anchor, b.anchor)
    )
  })
  return day
}
