import { useRef, useState } from 'react'
import type { Clip } from '../lib/model'
import { timeLabel, withBase } from '../lib/model'

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
  const frame = clip.frames[Math.min(position, clip.frames.length - 1)]
  return (
    <section className="player" aria-label="Activity timelapse">
      <video
        ref={video}
        controls
        preload="none"
        playsInline
        src={withBase(clip.url, base)}
        onTimeUpdate={() => {
          const t = video.current?.currentTime ?? 0
          setPosition(
            Math.max(
              0,
              clip.frames.findLastIndex((f) => f.offset <= t),
            ),
          )
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
            if (video.current) video.current.currentTime = clip.frames[i].offset
          }}
        />
        <span>
          {position + 1} / {clip.frames.length}
        </span>
      </label>
      {error && (
        <p role="alert">
          Video unavailable or unsupported. The frame links remain available.
        </p>
      )}
    </section>
  )
}
