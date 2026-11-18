import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { digest, safePath } from '@vandelay/ddb/model'
import { encodeJSON as encode } from './json'
import type { Asset, Current, ObjectRef, Publication, PublicationManifest, PublishedDay } from './model'
import { validateDay, validateManifest } from './validate'

/** Append-only object writes; a completed generation becomes visible with one pointer replacement. */
export function writePublication(root: string, publication: Publication, assets: Asset[], cache: string): Current {
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
      const bytes = encode(output)
      return { scope: day.scope, object: put(`days/${day.scope.day}/${digest(bytes)}.json`, bytes) }
    }),
  }
  validateManifest(manifest)
  const bytes = encode(manifest)
  const current: Current = {
    schema: 'vandelay.publish.current/v1',
    manifest: put(`publications/${digest(bytes)}/manifest.json`, bytes),
  }
  writeFileSync(join(root, 'current.json.tmp'), encode(current))
  renameSync(join(root, 'current.json.tmp'), join(root, 'current.json'))
  return current
}
