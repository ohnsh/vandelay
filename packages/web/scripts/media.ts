import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { digest, encode, safePath } from '@vandelay/ddb/model'
import type { DayView, Frame } from '../src/lib/model'

export interface Asset {
  path: string
  sha256: string
  bytes: number
  recipe: string
  inputs: { sha256: string; frameIndex?: number; presentation?: Frame['presentation'] }[]
}
export async function run(argv: string[]): Promise<string> {
  const child = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, status] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (status) throw new Error(`${argv[0]} exited ${status}: ${stderr.slice(-3000)}`)
  return stdout
}
export async function prepareMedia(
  days: DayView[],
  root: string,
  cache: string,
  enabled: boolean,
): Promise<Asset[]> {
  const allFrames = days.flatMap((d) => d.frames)
  const wanted = new Set(days.flatMap((d) => d.entries.flatMap((e) => e.frameKeys)))
  // One preview also makes a source with captures but no completed activities discoverable.
  for (const day of days)
    for (const source of day.sources) {
      const frame = day.frames.find((f) => f.source === source.slot && f.media)
      if (frame) wanted.add(frame.key)
    }
  if (!enabled) {
    for (const f of allFrames) if (f.media) f.previewStatus = 'Media preparation disabled'
    return []
  }
  if (!allFrames.some((f) => wanted.has(f.key) && f.media)) return []
  mkdirSync(cache, { recursive: true })
  const version = (await run(['ffmpeg', '-version'])).split('\n')[0]
  const recipe = `vandelay-web-preview/v1:${version}:exact-index:1280:webp-q85`
  const groups = new Map<string, Frame[]>()
  for (const frame of allFrames.filter((f) => wanted.has(f.key) && f.media)) {
    const media = frame.media!
    if (media.location.kind !== 'archive-relative') {
      frame.previewStatus = 'Remote media is not fetched'
      continue
    }
    const path = safePath(root, media.location.path)
    if (!existsSync(path)) {
      frame.previewStatus = 'Archived media is missing'
      continue
    }
    const group = groups.get(path) ?? []
    group.push(frame)
    groups.set(path, group)
  }
  const assets = new Map<string, Asset>()
  const cached = (key: string, extension: string): Asset | undefined => {
    const path = join(cache, `${key}.${extension}`),
      metadata = `${path}.json`
    if (!existsSync(path) || !existsSync(metadata)) return undefined
    try {
      const asset: Asset = JSON.parse(readFileSync(metadata, 'utf8'))
      const bytes = readFileSync(path)
      return asset.path === `/media/${key}.${extension}` &&
        bytes.length === asset.bytes &&
        digest(bytes) === asset.sha256
        ? asset
        : undefined
    } catch {
      return undefined
    }
  }
  const save = (
    key: string,
    extension: string,
    temporary: string,
    recipe: string,
    inputs: Asset['inputs'],
  ): Asset => {
    const file = readFileSync(temporary)
    const asset = {
      path: `/media/${key}.${extension}`,
      sha256: digest(file),
      bytes: file.length,
      recipe,
      inputs,
    }
    const path = join(cache, `${key}.${extension}`)
    renameSync(temporary, path)
    writeFileSync(`${path}.json`, JSON.stringify(asset))
    assets.set(asset.path, asset)
    return asset
  }
  let complete = 0
  for (const [path, frames] of groups) {
    const bytes = readFileSync(path),
      hash = digest(bytes)
    if (frames.some((f) => f.media!.sha256 !== hash || f.media!.bytes !== bytes.length))
      throw new Error(`Media hash/size mismatch: ${hash}`)
    const selected = new Map<number, { key: string; frames: Frame[] }>()
    for (const frame of frames) {
      const index = frame.frameIndex ?? 0
      if (!Number.isSafeInteger(index) || index < 0)
        throw new Error('Invalid frame index')
      const key = digest(
        encode({ hash, index, recipe, presentation: frame.presentation ?? null }),
      )
      const found = cached(key, 'webp')
      if (found) {
        assets.set(found.path, found)
        frame.preview = found.path
        frame.previewStatus = 'Prepared from verified archived bytes'
      } else {
        const group = selected.get(index) ?? { key, frames: [] }
        group.frames.push(frame)
        selected.set(index, group)
      }
    }
    if (selected.size) {
      const indices = [...selected.keys()].sort((a, b) => a - b)
      const temp = join(cache, `.frames-${hash}`)
      mkdirSync(temp, { recursive: true })
      try {
        // Decode by exact presentation-order frame index, never approximate timestamp seeking.
        // ffprobe also checks the source's declared presentation map.
        const probe = JSON.parse(
          await run([
            'ffprobe',
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_frames',
            '-show_entries',
            'frame=best_effort_timestamp_time',
            '-of',
            'json',
            path,
          ]),
        )
        for (const index of indices) {
          if (!probe.frames?.[index])
            throw new Error(`Missing decoded frame ${index} in ${hash}`)
          for (const frame of selected.get(index)!.frames) {
            if (!frame.presentation) continue
            const actual = Number(probe.frames[index].best_effort_timestamp_time)
            const expected =
              Number(frame.presentation.value) / frame.presentation.timescale
            if (!Number.isFinite(actual) || Math.abs(actual - expected) > 0.000002)
              throw new Error(`Frame/PTS disagreement in ${hash} at frame ${index}`)
          }
        }
        const select = indices.map((i) => `eq(n\\,${i})`).join('+')
        await run([
          'ffmpeg',
          '-v',
          'error',
          '-threads',
          '2',
          '-i',
          path,
          '-vf',
          `select=${select},scale=w='min(1280,iw)':h=-2`,
          '-fps_mode',
          'vfr',
          '-c:v',
          'libwebp',
          '-quality',
          '85',
          '-threads',
          '2',
          '-y',
          join(temp, '%06d.webp'),
        ])
        if (digest(readFileSync(path)) !== hash)
          throw new Error('Media changed during decoding')
        for (const [ordinal, index] of indices.entries()) {
          const selectedFrame = selected.get(index)!
          const asset = save(
            selectedFrame.key,
            'webp',
            join(temp, `${String(ordinal + 1).padStart(6, '0')}.webp`),
            recipe,
            [
              {
                sha256: hash,
                frameIndex: index,
                presentation: selectedFrame.frames[0].presentation,
              },
            ],
          )
          for (const frame of selectedFrame.frames) {
            frame.preview = asset.path
            frame.previewStatus = 'Prepared from verified archived bytes'
          }
        }
      } finally {
        rmSync(temp, { recursive: true, force: true })
      }
    }
    if (++complete % 25 === 0)
      console.log(`Media: ${complete}/${groups.size} source objects`)
  }
  // Propagate identical previews to other captures referencing the same object/frame.
  const selectorKey = (f: Frame) =>
    JSON.stringify([f.media?.sha256, f.frameIndex ?? 0, f.presentation ?? null])
  const previews = new Map(
    allFrames.filter((f) => f.preview).map((f) => [selectorKey(f), f.preview!]),
  )
  for (const f of allFrames)
    if (!f.preview && f.media) {
      f.preview = previews.get(selectorKey(f))
      if (f.preview) f.previewStatus = 'Prepared from verified archived bytes'
    }
  for (const day of days) {
    const frames = new Map(day.frames.map((f) => [f.key, f]))
    for (const entry of day.entries.filter((e) => e.frameKeys.length)) {
      const chosen = entry.frameKeys
        .map((k) => frames.get(k))
        .filter((f): f is Frame => !!f?.preview)
        .sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key))
      if (!chosen.length) {
        entry.mediaStatus = 'No selected archived frames are available'
        continue
      }
      const clipRecipe = `vandelay-web-montage/v1:${version}:0.5s-per-frame:1280x720:h264-crf23`
      const key = digest(
        encode({ recipe: clipRecipe, previews: chosen.map((f) => f.preview) }),
      )
      let asset = cached(key, 'mp4')
      if (!asset) {
        const temp = join(cache, `.clip-${key}`)
        mkdirSync(temp, { recursive: true })
        try {
          // Escape the cache root too: a checkout can legitimately contain an apostrophe.
          const concatPath = (preview: string) =>
            resolve(cache, preview.split('/').at(-1)!).replaceAll("'", "'\\''")
          const lines = chosen.flatMap((f) => [
            `file '${concatPath(f.preview!)}'`,
            'duration 0.5',
          ])
          lines.push(`file '${concatPath(chosen.at(-1)!.preview!)}'`)
          writeFileSync(join(temp, 'frames.txt'), lines.join('\n'))
          const output = join(temp, 'clip.mp4')
          await run([
            'ffmpeg',
            '-v',
            'error',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            join(temp, 'frames.txt'),
            '-vf',
            'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1',
            '-r',
            '24',
            '-t',
            String(chosen.length * 0.5),
            '-c:v',
            'libx264',
            '-threads',
            '2',
            '-preset',
            'fast',
            '-crf',
            '23',
            '-pix_fmt',
            'yuv420p',
            '-movflags',
            '+faststart',
            '-y',
            output,
          ])
          asset = save(
            key,
            'mp4',
            output,
            clipRecipe,
            chosen.map((f) => ({
              sha256: f.media!.sha256,
              frameIndex: f.frameIndex,
              presentation: f.presentation,
            })),
          )
        } finally {
          rmSync(temp, { recursive: true, force: true })
        }
      }
      assets.set(asset.path, asset)
      entry.clip = {
        url: asset.path,
        label: entry.source.startsWith('daycap/')
          ? 'Cited-sample timelapse · current archived renditions'
          : 'Contextual timelapse · up to 12 time-selected frames',
        frames: chosen.map((f, i) => ({
          at: f.at,
          href: f.href,
          recordID: f.recordID,
          offset: i * 0.5,
          // Every transition skips unsampled time; this is a montage, never a claim of continuous coverage.
          gap: i > 0,
        })),
      }
      entry.mediaStatus = `${chosen.length}/${entry.frameKeys.length} selected frames available · 0.5s display hold per frame`
    }
  }
  return [...assets.values()].sort((a, b) => a.path.localeCompare(b.path))
}
