import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { discoveryPath } from './discovery'
import { digest, safePath } from '@vandelay/ddb/model'
import { encodeJSON as encode } from './json'
import type { Asset, Current, ObjectRef, Publication, PublicationManifest, PublishedDay } from './model'
import { dailyPreview } from './preview'
import { validateDay, validateManifest, validatePlayback, validatePreview } from './validate'

/** Append-only object writes; a completed generation becomes visible with one pointer replacement. */
export function writePublication(root: string, publication: Publication, assets: Asset[], cache: string, channel?: string): Current {
  const pointer = safePath(root, discoveryPath(channel))
  mkdirSync(root, { recursive: true })
  const put = (path: string, bytes: Buffer): ObjectRef => {
    const target = safePath(root, path), sha256 = digest(bytes)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) {
      if (digest(readFileSync(target)) !== sha256) throw new Error(`Immutable object collision: ${path}`)
    } else {
      writeFileSync(`${target}.tmp`, bytes)
      renameSync(`${target}.tmp`, target)
    }
    return { path, sha256, bytes: bytes.length }
  }
  for (const asset of assets) {
    const source = safePath(cache, asset.path)
    const bytes = readFileSync(source)
    if (digest(bytes) !== asset.sha256 || bytes.length !== asset.bytes)
      throw new Error(`Invalid prepared asset: ${asset.path}`)
    const target = safePath(root, asset.path)
    mkdirSync(dirname(target), { recursive: true })
    if (existsSync(target)) {
      if (digest(readFileSync(target)) !== asset.sha256) throw new Error('Immutable asset collision')
    } else {
      copyFileSync(source, `${target}.tmp`)
      renameSync(`${target}.tmp`, target)
    }
  }
  const manifest: PublicationManifest = {
    ...publication,
    days: publication.days.map(day => {
      const referenced = new Set(day.frames.flatMap(f => [
        ...(f.preview ? [f.preview] : []), ...(f.playback ? [f.playback.asset] : []),
      ]))
      const output: PublishedDay = {
        ...day,
        assets: assets.filter(a => referenced.has(a.path)),
        frames: day.frames.map(({ media, ...frame }) => ({
          ...frame, ...(media ? { media: (({ location: _, ...rest }) => rest)(media) } : {}),
        })),
      }
      validateDay(output)
      const putJSON = (prefix: string, value: unknown) => {
        const bytes = encode(value)
        return put(`${prefix}/${digest(bytes)}.json`, bytes)
      }
      const preview = dailyPreview(output, playback => {
        validatePlayback(playback)
        return putJSON('playback', playback)
      })
      validatePreview(preview)
      return { scope: day.scope, object: putJSON(`days/${day.scope.day}`, output),
        preview: putJSON(`previews/${day.scope.day}`, preview) }
    }),
  }
  validateManifest(manifest)
  const bytes = encode(manifest)
  const current: Current = {
    schema: 'vandelay.publish.current/v1',
    manifest: put(`publications/${digest(bytes)}/manifest.json`, bytes),
  }
  mkdirSync(dirname(pointer), { recursive: true })
  writeFileSync(`${pointer}.tmp`, encode(current))
  renameSync(`${pointer}.tmp`, pointer)
  return current
}
