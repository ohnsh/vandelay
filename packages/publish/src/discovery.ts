/** Channel pointers share the publication root and all immutable objects. */
export function discoveryPath(channel?: string): string {
  if (channel === undefined) return 'current.json'
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(channel))
    throw new Error('Channel must be 1–64 lowercase letters, digits, hyphens or underscores, starting with a letter or digit')
  return `channels/${channel}.json`
}
