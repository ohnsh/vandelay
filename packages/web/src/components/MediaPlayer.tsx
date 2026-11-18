import { useEffect, useMemo, useRef, useState } from 'react'
import type { Clip } from '../lib/model'
import { timeLabel, withBase } from '../lib/model'
import { playbackRanges } from '../lib/playback'

/** Presentation-only: can also host an immutable review report's playback map. */
export default function MediaPlayer({
  clip,
  timezone,
  base,
}: {
  clip: Clip
  timezone: string
  base: string
}) {
  const video = useRef<HTMLVideoElement>(null)
  const [position, setPosition] = useState(0)
  const [error, setError] = useState(false)
  const ranges = useMemo(() => playbackRanges(clip), [clip])
  const [rangeIndex, setRangeIndex] = useState(0)
  const [speed, setSpeed] = useState(1)
  const resume = useRef(false)
  const pendingOffset = useRef<number | undefined>(undefined)
  const range = ranges[rangeIndex]
  const frame = clip.frames[Math.min(position, clip.frames.length - 1)]
  const initialize = () => {
    const el = video.current
    if (!el) return
    el.currentTime = pendingOffset.current ?? range.start
    pendingOffset.current = undefined
    el.playbackRate = speed
    if (resume.current) void el.play().catch(() => { resume.current = false })
  }
  const next = () => {
    const el = video.current
    if (!el) return
    if (rangeIndex + 1 >= ranges.length) {
      el.pause()
      setPosition(clip.frames.length - 1)
      return
    }
    resume.current = true
    setPosition(ranges[rangeIndex + 1].first)
    setRangeIndex(rangeIndex + 1)
  }
  useEffect(() => {
    setError(false)
    if (video.current && video.current.readyState >= 1) initialize()
  }, [rangeIndex])
  useEffect(() => {
    let request: number
    const tick = () => {
      const el = video.current
      if (el && !el.paused && !el.seeking) {
        if (el.currentTime >= range.end - 0.005) next()
        else {
          let i = range.first
          while (i < range.last && clip.frames[i + 1].offset <= el.currentTime) i++
          setPosition(i)
        }
      }
      request = requestAnimationFrame(tick)
    }
    request = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(request)
  }, [rangeIndex, clip])
  return (
    <section className="player" aria-label="Screen timelapse">
      <video
        ref={video}
        controls
        preload="none"
        playsInline
        src={withBase(range.url, base)}
        onLoadedMetadata={initialize}
        onEnded={next}
        onSeeking={() => {
          const el = video.current!
          if (el.currentTime < range.start || el.currentTime >= range.end)
            el.currentTime = Math.max(range.start, Math.min(el.currentTime, range.end - 0.01))
        }}
        onError={() => setError(true)}
      />
      <div className="player-caption">
        <strong>{clip.label}</strong>
        <a href={withBase(frame.href, base)}>
          {timeLabel({ model: 'instant', at: frame.at }, timezone)} · inspect frame
        </a>
        <span>
          {frame.gap
            ? 'Unsampled time skipped between frames'
            : 'Sample montage · playback time is not wall time'}
        </span>
      </div>
      <label className="frame-seek">
        Frame
        <input
          type="range"
          min={0}
          max={clip.frames.length - 1}
          value={position}
          aria-label="Select timelapse frame"
          onChange={(event) => {
            const i = Number(event.target.value)
            setPosition(i)
            const target = ranges.findIndex(r => i >= r.first && i <= r.last)
            resume.current = !!video.current && !video.current.paused
            if (target === rangeIndex && video.current) video.current.currentTime = clip.frames[i].offset
            else {
              pendingOffset.current = clip.frames[i].offset
              setRangeIndex(target)
            }
          }}
        />
        <span>
          {position + 1} / {clip.frames.length}
        </span>
      </label>
      <label>Playback speed <select value={speed} onChange={event => {
        const value = Number(event.target.value)
        setSpeed(value)
        if (video.current) video.current.playbackRate = value
      }}>{[0.5, 1, 2, 4, 8].map(value => <option key={value} value={value}>{value}×</option>)}</select></label>
      {error && (
        <p role="alert">
          Video unavailable or unsupported. The frame links remain available.
        </p>
      )}
    </section>
  )
}
