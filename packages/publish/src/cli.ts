import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { prepare } from './prepare'
import { r2Store, upload } from './upload'

const [command, ...args] = process.argv.slice(2)
if (command === 'build') {
  // Cache encoding also writes files; serialize CLI builds in this working directory.
  mkdirSync('.cache', { recursive: true })
  try { mkdirSync('.cache/publish.lock') }
  catch { throw new Error('Another publisher is active (.cache/publish.lock)') }
  try { console.log(JSON.stringify(await prepare(args), null, 2)) }
  finally { rmSync('.cache/publish.lock', { recursive: true, force: true }) }
} else if (command === 'upload') {
  const { values } = parseArgs({ args, options: {
    from: { type: 'string', default: 'dist' },
    channel: { type: 'string' },
    endpoint: { type: 'string', default: process.env.S3_ENDPOINT },
    bucket: { type: 'string', default: process.env.S3_BUCKET },
  } })
  if (!values.endpoint || !values.bucket) throw new Error('Supply --endpoint and --bucket (or S3_ENDPOINT/S3_BUCKET)')
  console.log(JSON.stringify(await upload(resolve(values.from!), r2Store(values.endpoint, values.bucket), values.channel), null, 2))
} else {
  throw new Error('Usage: bun src/cli.ts build [--repo PATH --commit REF --out PATH --stride 1..4 --source TYPE --channel NAME] | upload [--from PATH --endpoint URL --bucket NAME --channel NAME]')
}
