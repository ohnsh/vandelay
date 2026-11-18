import { at, type DailyPreview, type ObjectRef, type PlaybackManifest, type PublishedDay } from './model'

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
      const ranges: PlaybackManifest['ranges'] = []
      let poster: string | undefined
      for (const key of clip.frameKeys) {
        const frame = frames.get(key)!
        poster ??= frame.preview
        const { asset, offset, duration } = frame.playback!
        const prev = ranges.at(-1)
        if (prev && prev.url === asset && prev.end === offset) prev.end = offset + duration
        else ranges.push({ url: asset, start: offset, end: offset + duration })
      }
      return { source, stream, label: clip.label, poster,
        playback: putPlayback({ schema: 'vandelay.publish.playback/v1', ranges }) }
    }),
  }
}
