import { beforeAll, expect, test } from 'bun:test'
import { frameSelection } from '../src/frame-selection'
import { run } from '../src/media'

// Exercise FFmpeg itself, comparing selected pixels and source PTS rather than
// merely asserting the expression's spelling or the output frame count.
async function decoded(selection?: readonly number[]) {
  const output = await run([
    'ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=16x16:rate=1:duration=1000',
    ...(selection ? ['-vf', `select=${frameSelection(selection)}`] : []),
    '-fps_mode', 'passthrough', '-threads', '1', '-f', 'framemd5', '-',
  ])
  return output.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const fields = line.split(',').map(field => field.trim())
    return { pts: Number(fields[2]), md5: fields[5] }
  })
}
let source: Awaited<ReturnType<typeof decoded>>
beforeAll(async () => { source = await decoded() })
const consecutive = (count: number, start = 0, stride = 1) =>
  Array.from({ length: count }, (_, i) => start + i * stride)
test.each([
  { name: 'reported 120-frame selection', indices: consecutive(120) },
  { name: 'full 240-frame chunk', indices: consecutive(240) },
  { name: 'second chunk with nonzero indices', indices: consecutive(240, 240) },
  ...[2, 3, 4].map(stride => ({
    name: `240 sparse frames at stride ${stride}`, indices: consecutive(240, 7, stride),
  })),
  { name: 'irregular selection with holes and runs',
    indices: consecutive(1000).filter(i => i % 7 === 0 || i % 11 < 2).slice(0, 240) },
  { name: 'one frame', indices: [427] },
  { name: 'empty selection', indices: [] },
])('$name preserves exact frames and order', async ({ indices }) => {
  expect(await decoded(indices)).toEqual(indices.map(i => source[i]))
})
