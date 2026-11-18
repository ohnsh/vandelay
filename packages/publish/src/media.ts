import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { digest, safePath } from '@vandelay/ddb/model'
import { encodeJSON as encode } from './json'
import { at, type Asset, type Clip, type DayView, type Frame } from './model'
import { frameSelection } from './frame-selection'
import { maskFilters, type ReviewedRendition } from '@vandelay/autoredact'

export async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (status) throw new Error(`${argv[0]} exited ${status}: ${stderr.slice(-3000)}`)
  return stdout
}
const frameIdentity = (f: Frame) => JSON.stringify([f.media!.sha256, f.frameIndex ?? 0])
const chronological = (a: Frame, b: Frame) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key)
const streamIdentity = (f: Frame) => JSON.stringify([f.source, f.stream ?? null])

/** Every published source frame is encoded once, regardless of how many playlists use it. */
export async function prepareMedia(
  days: DayView[], root: string, cache: string, enabled: boolean, stride = 1, rendition?: ReviewedRendition,
): Promise<Asset[]> {
  if (![1, 2, 3, 4].includes(stride)) throw new Error('Capture stride must be 1, 2, 3 or 4')
  const all = days.flatMap(d => d.frames)
  for (const f of all) if (f.media && rendition && !rendition.allowsFrame(f.media.sha256, f.frameIndex ?? 0)) {
    f.previewStatus = 'Withheld by AutoRedact review'
    delete f.media
    delete f.preview
    delete f.playback
  }
  const wanted = new Set<Frame>()
  for (const day of days) {
    const streams = new Map<string, Frame[]>()
    for (const f of day.frames.filter(f => f.media)) {
      const key = streamIdentity(f)
      const frames = streams.get(key) ?? []
      frames.push(f); streams.set(key, frames)
    }
    for (const frames of streams.values())
      frames.sort(chronological).forEach((f, i) => {
        if (i % stride === 0) wanted.add(f)
        else f.previewStatus = `Omitted by capture stride ${stride}`
      })
  }
  if (!enabled) {
    for (const f of all) if (f.media) f.previewStatus = 'Media preparation disabled'
    return []
  }
  mkdirSync(cache, { recursive: true })
  const version = (await run(['ffmpeg', '-version'])).split('\n')[0]
  const recipe = `vandelay-chunk/v2:${version}:fps4:1280x720:h264-crf18:gop16:no-bframes:240frames:daycap-gap15s-times-stride${rendition ? `:autoredact:${rendition.digest}` : ''}`
  const filtersFor = (hash: string, indices: number[]) => {
    const selected = new Set(indices)
    return maskFilters((rendition?.masksFor(hash) ?? []).filter(m => selected.has(m.frame)))
  }
  const assets = new Map<string, Asset>()
  const remember = (asset: Asset) => {
    const previous = assets.get(asset.path)
    if (!previous) assets.set(asset.path, asset)
    else {
      // Identical rendered bytes can originate from different source objects.
      const inputs = new Map([...previous.inputs, ...asset.inputs].map(i => [encode(i).toString(), i]))
      assets.set(asset.path, { ...asset, inputs: [...inputs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, i]) => i) })
    }
  }
  const groups = new Map<string, { path: string; paths: Set<string>; frames: Frame[] }>()
  for (const f of wanted) {
    if (f.media!.location.kind !== 'archive-relative') {
      f.previewStatus = 'Remote media is not fetched'; continue
    }
    const path = safePath(root, f.media!.location.path)
    if (!existsSync(path)) { f.previewStatus = 'Archived media is missing'; continue }
    const group = groups.get(f.media!.sha256) ?? { path, paths: new Set<string>(), frames: [] }
    group.frames.push(f); group.paths.add(path); groups.set(f.media!.sha256, group)
  }
  const cached = (key: string): Asset | undefined => {
    try {
      const asset: Asset = JSON.parse(readFileSync(join(cache, `${key}.json`), 'utf8'))
      const bytes = readFileSync(safePath(cache, asset.path))
      if (digest(bytes) === asset.sha256 && bytes.length === asset.bytes) return asset
    } catch {}
  }
  const save = (key: string, file: string, inputs: Asset['inputs'], kind: 'mp4' | 'webp'): Asset => {
    const bytes = readFileSync(file), sha256 = digest(bytes)
    const asset: Asset = {
      path: `media/${sha256}.${kind}`, sha256, bytes: bytes.length,
      mediaType: kind === 'mp4' ? 'video/mp4' : 'image/webp',
      recipe: kind === 'mp4' ? recipe : `${recipe}:poster`, inputs,
    }
    mkdirSync(join(cache, 'media'), { recursive: true })
    renameSync(file, join(cache, asset.path))
    writeFileSync(join(cache, `${key}.json`), encode(asset))
    return asset
  }
  const locations = new Map<string, NonNullable<Frame['playback']>>()
  const posters = new Map<string, string>()
  for (const { path, paths, frames } of groups.values()) {
    const bytes = readFileSync(path), hash = digest(bytes)
    if (frames.some(f => f.media!.sha256 !== hash || f.media!.bytes !== bytes.length))
      throw new Error(`Media hash/size mismatch: ${hash}`)
    for (const alias of paths)
      if (alias !== path && digest(readFileSync(alias)) !== hash)
        throw new Error(`Media hash/size mismatch: ${alias}`)
    const indices = [...new Set(frames.map(f => f.frameIndex ?? 0))].sort((a, b) => a - b)
    if (indices.some(i => !Number.isSafeInteger(i) || i < 0)) throw new Error('Invalid frame index')
    // Check every declared selector, including cache hits and repeated frame references.
    const probe = JSON.parse(await run([
      'ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_frames',
      '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', path,
    ]))
    for (const f of frames) {
      const actual = probe.frames?.[f.frameIndex ?? 0]
      if (!actual) throw new Error(`Missing decoded frame in ${hash}`)
      if (f.presentation) {
        const pts = Number(actual.best_effort_timestamp_time)
        const expected = Number(f.presentation.value) / f.presentation.timescale
        if (!Number.isFinite(pts) || !Number.isFinite(expected) || Math.abs(pts - expected) > 0.000002)
          throw new Error(`Frame/PTS disagreement in ${hash}`)
      }
    }
    // One browsing poster per source object, rather than publishing a second full image sequence.
    const first = indices[0], posterKey = digest(encode({ recipe, hash, first, poster: true }))
    let poster = cached(posterKey)
    if (!poster) {
      const temp = join(cache, `${posterKey}.tmp.webp`)
      try {
        await run(['ffmpeg', '-v', 'error', '-i', path, '-vf',
          [...filtersFor(hash, [first]), `select=eq(n\\,${first}),scale=w='min(1280,iw)':h=-2`].join(','), '-frames:v', '1',
          '-c:v', 'libwebp', '-quality', '85', '-threads', '2', '-y', temp])
        poster = save(posterKey, temp, [{ sha256: hash, frameIndex: first, outputFrame: 0 }], 'webp')
      } finally { rmSync(temp, { force: true }) }
    }
    remember(poster)
    posters.set(JSON.stringify([hash, first]), poster.path)
    if (digest(readFileSync(path)) !== hash) throw new Error('Media changed during decoding')
  }
  const chunks: Frame[][] = []
  const assigned = new Set<string>()
  const plan = (frames: Frame[], contiguous: boolean) => {
    let chunk: Frame[] = []
    let previous: Frame | undefined
    for (const frame of frames) {
      const identity = frameIdentity(frame)
      const gap = previous ? Date.parse(frame.at) - Date.parse(previous.at) : 0
      if (chunk.length === 240 || (contiguous && previous &&
          (frame.session !== previous.session || gap < 0 || gap > 15000 * stride))) {
        if (chunk.length) chunks.push(chunk)
        chunk = []
      }
      previous = frame
      // Aliases share the same encoded location, even across days or streams.
      if (assigned.has(identity)) continue
      assigned.add(identity)
      chunk.push(frame)
    }
    if (chunk.length) chunks.push(chunk)
  }
  // Preserve source-object chunking for Dayflow.
  for (const group of groups.values())
    plan(group.frames.filter(f => !f.source.startsWith('daycap/'))
      .sort((a, b) => (a.frameIndex ?? 0) - (b.frameIndex ?? 0)), false)
  for (const day of days) {
    const streams = new Map<string, Frame[]>()
    for (const frame of day.frames) {
      if (!wanted.has(frame) || !frame.source.startsWith('daycap/') ||
          !frame.media || !groups.has(frame.media.sha256)) continue
      const key = streamIdentity(frame)
      const frames = streams.get(key) ?? []
      frames.push(frame); streams.set(key, frames)
    }
    for (const frames of streams.values()) plan(frames.sort(chronological), true)
  }
  for (const chunk of chunks) {
    const inputs = chunk.map((f, outputFrame) => ({
      sha256: f.media!.sha256, frameIndex: f.frameIndex ?? 0,
      outputFrame, presentation: f.presentation,
    }))
    const key = digest(encode({ recipe, inputs }))
    let asset = cached(key)
    if (!asset) {
      const temp = join(cache, `${key}.tmp.mp4`)
      // Consecutive runs preserve chronological order even if a source object recurs.
      const runs: Frame[][] = []
      for (const frame of chunk) {
        const last = runs.at(-1)
        if (last && last[0].media!.sha256 === frame.media!.sha256 &&
            (last.at(-1)!.frameIndex ?? 0) < (frame.frameIndex ?? 0)) last.push(frame)
        else runs.push([frame])
      }
      const filters = runs.map((frames, i) =>
        `[${i}:v:0]${[...filtersFor(frames[0].media!.sha256, frames.map(f => f.frameIndex ?? 0)), `select=${frameSelection(frames.map(f => f.frameIndex ?? 0))}`].join(',')},` +
        // setpts alone retains source durations; CFR then duplicates early frames.
        `settb=1/1000000,setpts=N/(4*TB),fps=4,trim=end_frame=${frames.length},` +
        `scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`)
      filters.push(runs.map((_, i) => `[v${i}]`).join('') +
        `concat=n=${runs.length}:v=1:a=0[out]`)
      try {
        writeFileSync(`${temp}.filter`, filters.join(';'), { mode: 0o600 })
        await run([
          'ffmpeg', '-v', 'error', '-filter_complex_threads', '1',
          ...runs.flatMap(frames => ['-threads', '2', '-i', groups.get(frames[0].media!.sha256)!.path]),
          '-/filter_complex', `${temp}.filter`, '-map', '[out]', '-an',
          '-r', '4', '-fps_mode', 'cfr', '-frames:v', String(chunk.length),
          '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18',
          '-g', '16', '-bf', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-y', temp,
        ])
        const output = JSON.parse(await run([
          'ffprobe', '-v', 'error', '-count_frames', '-select_streams', 'v:0',
          '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', temp,
        ])).streams[0]
        if (Number(output.nb_read_frames) !== chunk.length ||
            Math.abs(Number(output.duration) - chunk.length / 4) > 0.00001)
          throw new Error('Unexpected timelapse frame count or duration')
        asset = save(key, temp, inputs, 'mp4')
      } finally { rmSync(temp, { force: true }); rmSync(`${temp}.filter`, { force: true }) }
    }
    remember(asset)
    chunk.forEach((frame, ordinal) => locations.set(frameIdentity(frame), {
      asset: asset!.path, offset: ordinal / 4, duration: 0.25,
    }))
  }
  for (const [hash, group] of groups)
    if (digest(readFileSync(group.path)) !== hash) throw new Error('Media changed during decoding')
  for (const f of wanted) {
    f.playback = locations.get(frameIdentity(f))
    f.preview = posters.get(frameIdentity(f))
    if (f.playback) f.previewStatus = 'Prepared from verified archived bytes'
  }
  for (const day of days) {
    const playable = day.frames.filter(f => f.playback).sort(chronological)
    const streams = new Map<string, Frame[]>()
    for (const f of playable) {
      const key = streamIdentity(f), frames = streams.get(key) ?? []
      frames.push(f); streams.set(key, frames)
    }
    day.timelapses = [...streams.values()].map(frames => ({
      source: frames[0].source, stream: frames[0].stream,
      clip: {
        label: `Day screen timelapse · capture stride ${stride} · sampled time`,
        selection: 'day', frameKeys: frames.map(f => f.key),
      },
    }))
    for (const entry of day.entries.filter(e => e.track === 'activity' && e.status === 'active')) {
      const start = at(entry.placement)
      const end = 'end' in entry.placement ? entry.placement.end : start
      // frameKeys remain citation/context identities. Playback includes every capture in the
      // activity's bounds, including captures not submitted to the source model.
      const selected = playable.filter(f => f.source === entry.source && start && end &&
        f.at >= start && (entry.time.model === 'interval' ? f.at < end : f.at <= end))
      if (!selected.length) { entry.mediaStatus = 'No playable captures in activity bounds'; continue }
      entry.clip = {
        label: `Activity-range timelapse · current captures · stride ${stride}`,
        selection: 'activity-time-range', frameKeys: selected.map(f => f.key),
      } satisfies Clip
      entry.mediaStatus = `${selected.length} captures · contextual time selection, not additional citations · 0.25s per frame`
    }
  }
  return [...assets.values()].sort((a, b) => a.path.localeCompare(b.path))
}
