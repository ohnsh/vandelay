import type * as Public from '@vandelay/publish/model'
export { at, timeLabel, timeBasis } from '@vandelay/publish/model'
export type { Track, Ref } from '@vandelay/publish/model'
export type Link = Public.Link & { href?: string }
export type Detail = Omit<Public.Detail, 'supports'> & { supports: Link[] }
export type Frame = Public.PublishedFrame & { href: string }
export interface Clip {
  label: string
  frames: {
    key: string; at: string; href: string; offset: number; duration: number
    url: string; gap: boolean; recordID: string
  }[]
}
export type Entry = Omit<Public.Entry, 'clip' | 'links' | 'details'> & {
  href: string; clip?: Clip; links: Link[]; details: Detail[]
}
export type DayView = Omit<Public.PublishedDay, 'frames' | 'entries' | 'timelapses'> & {
  frames: Frame[]; entries: Entry[]
  timelapses: { source: string; stream?: string; clip: Clip }[]
}
export type Publication = Omit<Public.Publication, 'days'> & { days: DayView[] }
export function withBase(path: string, base = import.meta.env.BASE_URL): string {
  if (/^https?:\/\//.test(path)) return path
  return `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}`
}
