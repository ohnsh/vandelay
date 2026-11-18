/** A filtergraph-escaped select expression for sorted, unique presentation-order indices. */
export function frameSelection(indices: readonly number[]): string {
  const terms: string[] = []
  for (let i = 0; i < indices.length; i++) {
    const first = indices[i]
    while (i + 1 < indices.length && indices[i + 1] === indices[i] + 1) i++
    const last = indices[i]
    terms.push(first === last ? `eq(n\\,${first})` : `between(n\\,${first}\\,${last})`)
  }
  // FFmpeg's expression parser has a recursion limit: a flat sum of even 120 eq()
  // terms can fail with ENOMEM. Ranges compact dense selections; balancing also
  // bounds parser depth for sparse/irregular selections at the full chunk size.
  const sum = (start: number, end: number): string => {
    if (end - start === 1) return terms[start]
    const middle = start + Math.floor((end - start) / 2)
    return `(${sum(start, middle)}+${sum(middle, end)})`
  }
  return terms.length ? sum(0, terms.length) : '0'
}
