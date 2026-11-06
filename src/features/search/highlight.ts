/**
 * Highlighting of the matched part of a result title.
 *
 * `searchWorkspace` matches on NFKC-normalised, lower-cased text ("Ｑ４" is found by "q4", "É" by
 * "é"), so the matches are located in that normalised form and mapped back onto the original
 * string. Substring matching per term, so it works for CJK text without word segmentation, and a
 * range never splits a surrogate pair or a base character from its combining marks.
 */
import { normalizeSearchText } from '@/domain/search'

export interface HighlightSegment {
  text: string
  match: boolean
}

const MARK = /^\p{M}$/u

/** Code points that belong to the character before them: marks, Hangul medial/final jamo, joiners. */
function attachesToPrevious(codePoint: number, char: string): boolean {
  return (
    (codePoint >= 0x1160 && codePoint <= 0x11ff) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    MARK.test(char)
  )
}
const WHITESPACE = /^\s$/u

/** [start, end) in UTF-16 units. */
type Range = readonly [number, number]

interface Unit {
  start: number
  end: number
}

/** Original text cut into normalisation units: one code point plus the marks that attach to it. */
function unitsOf(text: string): Unit[] {
  const units: Unit[] = []
  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index) as number
    const char = String.fromCodePoint(codePoint)
    const end = index + char.length
    const previous = units.at(-1)
    if (previous && attachesToPrevious(codePoint, char)) previous.end = end
    else units.push({ start: index, end })
    index = end
  }
  return units
}

/**
 * The text in search form (see `normalizeSearchText`) plus, for each of its UTF-16 units, the
 * index of the original unit it came from. Null when the unit-wise result differs from the
 * domain's whole-string normalisation (context-sensitive case mapping such as Greek final sigma):
 * highlighting is cosmetic, so those titles are simply left plain.
 */
function normalizeWithOrigins(
  text: string,
  units: readonly Unit[],
): { normalized: string; origins: number[] } | null {
  let normalized = ''
  const origins: number[] = []
  units.forEach((unit, unitIndex) => {
    const piece = text.slice(unit.start, unit.end).normalize('NFKC').toLowerCase()
    for (const char of piece) {
      if (WHITESPACE.test(char)) {
        if (normalized === '' || normalized.endsWith(' ')) continue // collapse runs, trim the start
        normalized += ' '
        origins.push(unitIndex)
      } else {
        normalized += char
        for (let i = 0; i < char.length; i += 1) origins.push(unitIndex)
      }
    }
  })
  if (normalized.endsWith(' ')) {
    normalized = normalized.slice(0, -1)
    origins.pop()
  }
  return normalized === normalizeSearchText(text) ? { normalized, origins } : null
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged: [number, number][] = []
  for (const [start, end] of sorted) {
    const last = merged.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** Ranges of `text` (original string) matched by any whitespace-separated term of `query`. */
export function highlightRanges(text: string, query: string): Range[] {
  const terms = normalizeSearchText(typeof query === 'string' ? query : '')
    .split(' ')
    .filter(Boolean)
  if (terms.length === 0 || text === '') return []
  const units = unitsOf(text)
  const mapped = normalizeWithOrigins(text, units)
  if (!mapped) return []

  const found: Range[] = []
  for (const term of terms) {
    for (
      let at = mapped.normalized.indexOf(term);
      at !== -1;
      at = mapped.normalized.indexOf(term, at + 1)
    ) {
      found.push([at, at + term.length])
    }
  }
  return mergeRanges(
    mergeRanges(found).map(([start, end]): Range => [
      units[mapped.origins[start]].start,
      units[mapped.origins[end - 1]].end,
    ]),
  )
}

/** `text` cut into consecutive plain / matched segments (always at least one segment). */
export function splitHighlight(text: string, query: string): HighlightSegment[] {
  const segments: HighlightSegment[] = []
  let cursor = 0
  for (const [start, end] of highlightRanges(text, query)) {
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false })
    segments.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length || segments.length === 0) {
    segments.push({ text: text.slice(cursor), match: false })
  }
  return segments
}

/** True when every whitespace-separated term of `query` occurs in `text` (search rules). */
export function containsEveryTerm(text: string, query: string): boolean {
  const normalized = normalizeSearchText(text)
  const terms = normalizeSearchText(typeof query === 'string' ? query : '')
    .split(' ')
    .filter(Boolean)
  return terms.length > 0 && terms.every((term) => normalized.includes(term))
}

const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff
const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff

/**
 * Why a result whose TITLE does not show the whole query matched anyway: a short excerpt of its
 * description around the first match, on one line ("…prototype for the interview sessions…").
 * Null when the title already contains every term, or the description has no match to show.
 */
export function matchSnippet(
  title: string,
  description: string | null | undefined,
  query: string,
  { before = 24, length = 90 }: { before?: number; length?: number } = {},
): string | null {
  if (!description || containsEveryTerm(title, query)) return null
  const flat = description.replace(/\s+/gu, ' ').trim()
  const [first] = highlightRanges(flat, query)
  if (!first) return null

  let from = Math.max(0, first[0] - before)
  if (from > 0) {
    // Start on a word boundary where the text has words; never inside a surrogate pair.
    const space = flat.indexOf(' ', from)
    if (space !== -1 && space < first[0]) from = space + 1
    else if (isLowSurrogate(flat.charCodeAt(from))) from += 1
  }
  let to = Math.min(flat.length, Math.max(from + length, first[1]))
  if (to < flat.length && isHighSurrogate(flat.charCodeAt(to - 1))) to -= 1
  return `${from > 0 ? '…' : ''}${flat.slice(from, to)}${to < flat.length ? '…' : ''}`
}
