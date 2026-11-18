import { at, type DailyPreview, type ObjectRef, type PlaybackManifest, type PublishedDay } from './model'
import { clipPresentation } from './presentation'

function excerpt(value: string, limit: number) {
  const chars = Array.from(value.trim().replace(/\s+/gu, ' '))
  return chars.length <= limit ? chars.join('') : chars.slice(0, limit - 1).join('') + '…'
}

export function dailyPreview(day: PublishedDay, putPlayback: (map: PlaybackManifest) => ObjectRef): DailyPreview {
  const activities = day.entries.filter(e => e.status === 'active' && e.track === 'activity' && at(e.placement))
  const selected = activities.length <= 3 ? activities :
    [activities[0], activities[Math.floor(activities.length / 2)], activities[activities.length - 1]]
  const frames = new Map(day.frames.map(f => [f.key, f]))
  return {
    schema: 'vandelay.publish.preview/v1', scope: day.scope,
    highlights: selected.map(e => ({
      anchor: e.anchor, at: at(e.placement)!, title: excerpt(e.title, 120), summary: excerpt(e.text, 240),
    })),
    timelapses: day.timelapses.map(({ source, stream, clip }) => {
      const { poster, map } = clipPresentation(clip, frames)
      return { source, stream, label: clip.label, poster,
        playback: putPlayback(map) }
    }),
  }
}
