import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { Repository } from '../../src/repository'
import { digest, encode, expand, type Manifest } from '../../src/model'
import { projectDay, type Bundle } from '../src/lib/project'
import type { Publication } from '../src/lib/model'
import { prepareMedia } from './media'

export async function prepare(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      repo: { type: 'string', default: '../data' },
      commit: { type: 'string', default: 'HEAD' },
      day: { type: 'string', multiple: true },
      'media-archive': { type: 'string', default: '~/.local/share/did/media' },
      media: { type: 'string', default: 'selected' },
      signature: { type: 'boolean', default: false },
      'media-urls': { type: 'string' },
    },
  })
  if (!['none', 'selected'].includes(values.media!))
    throw new Error('--media must be selected or none')
  const repo = new Repository(resolve(values.repo!))
  repo.assertRepository()
  const commit = repo.resolveCommit(values.commit!)
  const paths = repo
    .git('ls-tree', '-r', '--name-only', commit)
    .toString()
    .trim()
    .split('\n')
  const dates = paths
    .filter((p) => /^\d{4}\/\d{2}\/\d{2}\.json$/.test(p))
    .map((p) => p.slice(0, -5).replaceAll('/', '-'))
  if (values.day?.some((d) => !dates.includes(d)))
    throw new Error('Selected day is absent from this commit')
  const selected = dates.filter((d) => !values.day || values.day.includes(d)).sort()
  if (!selected.length) throw new Error('No day manifests in snapshot')
  if (values.signature) repo.git('verify-commit', commit)
  const blob = (path: string) => repo.git('cat-file', 'blob', `${commit}:${path}`)
  const days = selected.map((date) => {
    console.log(`Verify and project ${date} @ ${commit.slice(0, 12)}`)
    const day = repo.verify(date, commit)
    const bundles: Bundle[] = Object.values(day.sources).map((ref) => {
      const manifest: Manifest = JSON.parse(blob(ref.path).toString())
      const prefix = ref.path.slice(0, -'manifest.json'.length)
      const records = blob(`${prefix}records.jsonl`).toString().trim()
      return {
        manifest,
        path: ref.path,
        sha256: ref.sha256,
        records: records ? records.split('\n').map((line) => JSON.parse(line)) : [],
        evidence: JSON.parse(blob(`${prefix}evidence.json`).toString()),
        references:
          manifest.source.type === 'daycap'
            ? JSON.parse(blob(`${prefix}references.json`).toString())
            : undefined,
      }
    })
    return projectDay(bundles, day.scope)
  })
  const urls: Record<string, string> = values['media-urls']
    ? JSON.parse(readFileSync(expand(values['media-urls']), 'utf8'))
    : {}
  for (const [hash, url] of Object.entries(urls)) {
    if (
      !/^[a-f0-9]{64}$/.test(hash) ||
      typeof url !== 'string' ||
      new URL(url).protocol !== 'https:'
    )
      throw new Error('Media URL map must contain SHA-256 keys and HTTPS URLs')
  }
  for (const day of days)
    for (const entry of day.entries)
      if (entry.recordings) {
        for (const media of entry.recordings)
          if (urls[media.sha256]) media.url = urls[media.sha256]
        if (entry.recordings.some((m) => m.url))
          entry.mediaStatus =
            'Configured external recording URL · remote availability and bytes not verified'
      }
  const assets = await prepareMedia(
    days,
    expand(values['media-archive']!),
    '.cache/media',
    values.media === 'selected',
  )
  const publication: Publication = {
    schema: 'did.web/v1',
    commit,
    generator: '@did/web/0.1.0',
    inputDigest: digest(
      encode({
        commit,
        days: days.map((d) => ({ scope: d.scope, sources: d.sources })),
        media: values.media,
        urls,
      }),
    ),
    verification: {
      archive: 'verified',
      signature: values.signature ? 'verified by Git trust configuration' : 'not checked',
      timestamp: 'not checked',
    },
    days,
  }
  mkdirSync('.data', { recursive: true })
  // Publish the prepared projection last. Readers consume this one complete generation.
  const prepared = { publication, assets }
  writeFileSync('.data/prepared.tmp', JSON.stringify(prepared))
  renameSync('.data/prepared.tmp', '.data/prepared.json')
  console.log(
    `Prepared ${days.length} days, ${days.reduce((n, d) => n + d.entries.length, 0)} entries, ${assets.length} media assets`,
  )
  return prepared
}
if (import.meta.main) {
  mkdirSync('.data', { recursive: true })
  try {
    mkdirSync('.data/build.lock')
  } catch {
    throw new Error('Another web build is active (.data/build.lock)')
  }
  try {
    await prepare(process.argv.slice(2))
  } finally {
    rmSync('.data/build.lock', { recursive: true, force: true })
  }
}
