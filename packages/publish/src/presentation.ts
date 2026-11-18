import { at, type Clip, type Entry, type PlaybackManifest, type PublishedFrame } from './model'

/** Keep Dayflow's clock strings as source prose, including ambiguous midnight/DST dates. */
export function detailRows(entry: Entry, timezone: string) {
  const format = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' })
  return entry.details.flatMap(detail => {
    if (entry.kind !== 'dayflow.timeline_cards') {
      const start = detail.time && at(detail.time)
      const first = start && format.format(new Date(start))
      const last = detail.time && 'end' in detail.time && format.format(new Date(detail.time.end))
      return [{ time: first && last && last !== first ? `${first} – ${last}` : first, text: detail.text }]
    }
    const rows: { time?: string; text: string }[] = []
    for (const line of detail.text.split(/\r?\n/)) {
      const m = /^\s*((?:\d{1,2}:\d{2}\s*(?:[AP]M)?)(?:\s*[-–—]\s*\d{1,2}:\d{2}\s*(?:[AP]M)?)?)\s*:\s*(.*)$/i.exec(line)
      if (m) rows.push({ time: m[1].trim(), text: m[2] })
      else if (rows.length) rows[rows.length - 1].text += `\n${line}`
      else rows.push({ text: line })
    }
    return rows
  })
}

export function clipPresentation(clip: Clip, frames: ReadonlyMap<string, PublishedFrame>) {
  const ranges: PlaybackManifest['ranges'] = []
  const clock: NonNullable<PlaybackManifest['clock']> = []
  let poster: string | undefined, elapsed = 0, minute = NaN
  for (const key of clip.frameKeys) {
    const frame = frames.get(key)!
    poster ??= frame.preview
    const { asset: url, offset: start, duration } = frame.playback!
    const captureMinute = Math.floor(Date.parse(frame.at) / 60000)
    if (captureMinute !== minute) clock.push({ elapsed, at: frame.at })
    minute = captureMinute
    const prev = ranges.at(-1)
    if (prev && prev.url === url && prev.end === start) prev.end = start + duration
    else ranges.push({ url, start, end: start + duration })
    elapsed += duration
  }
  const map: PlaybackManifest = { schema: 'vandelay.publish.playback/v1', ranges, clock }
  return { poster, map }
}
