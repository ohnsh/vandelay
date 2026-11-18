import { encode } from '@vandelay/ddb/model'
/** Optional TypeScript fields are omitted on the wire; non-finite numbers are never coerced to null. */
export function encodeJSON(value: unknown): Buffer {
  const text = JSON.stringify(value, (_key, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Non-finite publication number')
    return v
  })
  return encode(JSON.parse(text))
}
