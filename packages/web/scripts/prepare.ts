import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { safePath } from '@vandelay/ddb/model'
import { httpReader, openPublication } from '@vandelay/publish/reader'
import type { Asset } from '@vandelay/publish/model'
import { presentDay } from '../src/lib/presentation'
import type { Publication } from '../src/lib/model'

export async function prepare(args: string[]) {
  const { values } = parseArgs({ args, options: {
    publication: { type: 'string', default: '../publish/dist' },
    'asset-base': { type: 'string' },
    'copy-media': { type: 'boolean', default: false },
    day: { type: 'string', multiple: true },
    pin: { type: 'string' },
  } })
  const source = values.publication!
  const remote = /^https?:\/\//.test(source)
  if (remote && values['copy-media']) throw new Error('--copy-media requires a local publication')
  const root = remote ? undefined : resolve(source)
  const read = root
    ? async (path: string) => readFileSync(safePath(root, path))
    : httpReader(source)
  const reader = await openPublication(read, values.pin ? JSON.parse(readFileSync(values.pin, 'utf8')) : undefined)
  if (values.day?.some(date => !reader.manifest.days.some(d => d.scope.day === date)))
    throw new Error('Selected day is absent from publication')
  const assetBase = values['asset-base'] ?? (remote ? source : '')
  if (assetBase && !/^https?:\/\//.test(assetBase)) throw new Error('--asset-base must be an HTTP(S) URL')
  const days = []
  const inventory = new Map<string, Asset>()
  for (const d of reader.manifest.days) {
    if (values.day && !values.day.includes(d.scope.day)) continue
    const day = (await reader.day(d.scope.day))!
    for (const asset of day.assets) inventory.set(asset.path, asset)
    days.push(presentDay(day, assetBase))
  }
  const assets = [...inventory.values()].sort((a, b) => a.path.localeCompare(b.path))
  if (!assetBase && !values['copy-media'] && assets.length)
    throw new Error('Supply --asset-base for hosted media, or --copy-media for a self-contained local preview')
  const { days: _, ...metadata } = reader.manifest
  const publication: Publication = { ...metadata, days }
  const prepared = {
    publication, assets, current: reader.current,
    copyRoot: values['copy-media'] ? root : undefined,
  }
  mkdirSync('.data', { recursive: true })
  writeFileSync('.data/prepared.tmp', JSON.stringify(prepared))
  renameSync('.data/prepared.tmp', '.data/prepared.json')
  return prepared
}
if (import.meta.main) {
  mkdirSync('.data', { recursive: true })
  try { mkdirSync('.data/build.lock') }
  catch { throw new Error('Another web build is active (.data/build.lock)') }
  try { await prepare(process.argv.slice(2)) }
  finally { rmSync('.data/build.lock', { recursive: true, force: true }) }
}
