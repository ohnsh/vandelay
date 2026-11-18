import type { Clip as PublicClip, PublishedDay } from '@vandelay/publish/model'
import type { Clip, DayView, Link } from './model'

/** Routes and media origins belong to this consumer, never to the publication format. */
export function presentDay(day: PublishedDay, assetBase: string): DayView {
  const assetURL = (path: string) => `${assetBase.replace(/\/$/, '')}/${path}`
  const counts = new Map<string, number>()
  const frames = day.frames.map(f => {
    const index = counts.get(f.source) ?? 0
    counts.set(f.source, index + 1)
    return { ...f,
      href: `/frames/${day.scope.day}/${f.source}/${Math.floor(index / 100) + 1}/#${f.anchor}`,
      preview: f.preview ? assetURL(f.preview) : undefined,
    }
  })
  const byKey = new Map(frames.map(f => [f.key, f]))
  const routes = new Map(frames.map(f => [f.key, f.href]))
  for (const e of day.entries)
    routes.set(JSON.stringify([e.source, e.recordID]), `/days/${day.scope.day}/#${e.anchor}`)
  const link = (l: Link): Link => ({ ...l, href: l.target ? routes.get(l.id) : undefined })
  const clip = (c: PublicClip): Clip => ({
    label: c.label,
    frames: c.frameKeys.map((key, i) => {
      const f = byKey.get(key)!
      if (!f?.playback) throw new Error('Unplayable publication capture')
      return {
        key, at: f.at, href: f.href, recordID: f.recordID, gap: i > 0,
        url: assetURL(f.playback.asset), offset: f.playback.offset, duration: f.playback.duration,
      }
    }),
  })
  return {
    ...day, frames,
    timelapses: day.timelapses.map(t => ({ ...t, clip: clip(t.clip) })),
    entries: day.entries.map(e => ({
      ...e, href: routes.get(JSON.stringify([e.source, e.recordID]))!,
      links: e.links.map(link), details: e.details.map(d => ({ ...d, supports: d.supports.map(link) })),
      clip: e.clip ? clip(e.clip) : undefined,
    })),
  }
}
