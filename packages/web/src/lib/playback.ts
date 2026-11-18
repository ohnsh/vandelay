import type { Clip } from './model'
export interface PlaybackRange {
  url: string; start: number; end: number; first: number; last: number
}
/** Adjacent captures in the same asset play without seeks; holes and chunk changes form boundaries. */
export function playbackRanges(clip: Clip): PlaybackRange[] {
  const ranges: PlaybackRange[] = []
  clip.frames.forEach((f, i) => {
    const previous = ranges.at(-1)
    if (previous && previous.url === f.url && Math.abs(previous.end - f.offset) < 0.000001) {
      previous.end = f.offset + f.duration
      previous.last = i
    } else ranges.push({ url: f.url, start: f.offset, end: f.offset + f.duration, first: i, last: i })
  })
  return ranges
}
