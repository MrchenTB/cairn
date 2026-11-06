import { describe, expect, it } from 'vitest'
import { containsEveryTerm, highlightRanges, matchSnippet, splitHighlight } from './highlight'

/** U+0301 COMBINING ACUTE ACCENT, built from its code point so no editor can normalise it. */
const ACUTE = String.fromCodePoint(0x301)

const matched = (text: string, query: string) =>
  splitHighlight(text, query)
    .filter((segment) => segment.match)
    .map((segment) => segment.text)

describe('splitHighlight', () => {
  it('marks every term, case-insensitively, and keeps the original casing', () => {
    expect(splitHighlight('Write Launch plan', 'launch')).toEqual([
      { text: 'Write ', match: false },
      { text: 'Launch', match: true },
      { text: ' plan', match: false },
    ])
    expect(matched('Write Launch plan', 'PLAN wri')).toEqual(['Wri', 'plan'])
  })

  it('merges overlapping and repeated matches', () => {
    expect(matched('aaaa', 'aa')).toEqual(['aaaa'])
    expect(matched('launch launch', 'launch aun')).toEqual(['launch', 'launch'])
  })

  it('works for CJK text without word boundaries', () => {
    expect(matched('準備 demo 報告', '報告')).toEqual(['報告'])
    expect(matched('準備 demo 報告', 'demo')).toEqual(['demo'])
    expect(matched('季度報告初稿', '度報')).toEqual(['度報'])
    // Touching matches become one highlight.
    expect(matched('準備demo', 'demo 準備')).toEqual(['準備demo'])
  })

  it('matches through NFKC normalisation and maps back to the original characters', () => {
    expect(matched('Ｑ４ report', 'q4')).toEqual(['Ｑ４'])
    expect(matched('ﬁnal plan', 'final')).toEqual(['ﬁnal'])
    expect(matched(`Cafe${ACUTE} menu`, 'café')).toEqual([`Cafe${ACUTE}`])
  })

  it('never splits a surrogate pair or a character from its combining mark', () => {
    expect(matched('Party 😀 plan', '😀')).toEqual(['😀'])
    // "é" is one character for the search: its mark is highlighted together with the base letter.
    expect(matched(`Cafe${ACUTE}`, 'é')).toEqual([`e${ACUTE}`])
    expect(matched(`Cafe${ACUTE}`, 'caf')).toEqual(['Caf'])
    const [first] = highlightRanges('𠮷野家', '野')
    expect(first).toEqual([2, 3])
  })

  it('treats runs of whitespace like the search does', () => {
    // Terms are matched separately; the collapsed whitespace must not shift later ranges.
    expect(matched('a   b  c', 'a b')).toEqual(['a', 'b'])
    expect(highlightRanges('a   b  c', 'c')).toEqual([[7, 8]])
    expect(matched('  padded title', 'padded title')).toEqual(['padded', 'title'])
    expect(highlightRanges('  padded title', 'title')).toEqual([[9, 14]])
  })

  it('returns one plain segment when nothing matches or the query is blank', () => {
    expect(splitHighlight('Nothing here', 'zzz')).toEqual([{ text: 'Nothing here', match: false }])
    expect(splitHighlight('Nothing here', '   ')).toEqual([{ text: 'Nothing here', match: false }])
    expect(splitHighlight('', 'x')).toEqual([{ text: '', match: false }])
  })

  it('reassembles to the original text', () => {
    const text = 'Ｑ４ 報告 — café 😀 final'
    const query = 'q4 café 😀 報'
    expect(
      splitHighlight(text, query)
        .map((segment) => segment.text)
        .join(''),
    ).toBe(text)
  })

  it('leaves exotic case mappings plain instead of mis-highlighting', () => {
    // Greek final sigma: the whole-string lower-casing differs from a per-character one.
    expect(highlightRanges('ΟΔΟΣ', 'οδος')).toEqual([])
  })
})

describe('containsEveryTerm', () => {
  it('needs every term, in any order, with the same normalisation as the search', () => {
    expect(containsEveryTerm('Write launch plan', 'plan launch')).toBe(true)
    expect(containsEveryTerm('Write launch plan', 'plan budget')).toBe(false)
    expect(containsEveryTerm('Ｑ４ 報告', 'q4 報告')).toBe(true)
    expect(containsEveryTerm('anything', '   ')).toBe(false)
  })
})

describe('matchSnippet', () => {
  const description =
    'A clickable prototype for the interview sessions, used to walk people through the flow.'

  it('quotes the description around the first match when the title does not show it', () => {
    expect(matchSnippet('Prototype flow', description, 'interview')).toBe(
      '…prototype for the interview sessions, used to walk people through the flow.',
    )
    // The match is near the start: nothing to cut off in front.
    expect(
      matchSnippet('Prototype flow', description, 'clickable')?.startsWith('A clickable'),
    ).toBe(true)
  })

  it('is null when the title already contains every term or the description has no match', () => {
    expect(matchSnippet('Interview users', description, 'interview')).toBeNull()
    expect(matchSnippet('Prototype flow', description, 'zzz')).toBeNull()
    expect(matchSnippet('Prototype flow', null, 'interview')).toBeNull()
    expect(matchSnippet('Prototype flow', '', 'interview')).toBeNull()
  })

  it('explains the term the title lacks when the other one is in the title', () => {
    expect(matchSnippet('Prototype flow', description, 'prototype sessions')).toContain('sessions')
  })

  it('shortens long text with ellipses and keeps the match inside', () => {
    const long = `${'lorem ipsum '.repeat(30)}needle ${'dolor sit '.repeat(30)}`
    const snippet = matchSnippet('Title', long, 'needle', { before: 20, length: 60 }) as string
    expect(snippet.startsWith('…')).toBe(true)
    expect(snippet.endsWith('…')).toBe(true)
    expect(snippet).toContain('needle')
    expect(snippet.length).toBeLessThanOrEqual(60 + 2)
  })

  it('puts line breaks and runs of spaces on one line', () => {
    expect(matchSnippet('Title', 'first\n\nsecond   with needle', 'needle')).toBe(
      'first second with needle',
    )
  })

  it('works for CJK text and never cuts a surrogate pair', () => {
    const cjk = '市場調查與使用者訪談計畫，包含逐字稿、洞察摘要與後續行動項目，需要在下週前交付。'
    const snippet = matchSnippet('Roadmap 規劃', cjk, '訪談', { before: 4, length: 12 }) as string
    expect(snippet).toContain('訪談')
    expect(snippet.startsWith('…')).toBe(true)
    const astral = `${'😀'.repeat(20)}needle${'😀'.repeat(20)}`
    const out = matchSnippet('T', astral, 'needle', { before: 5, length: 20 }) as string
    // No lone surrogate halves anywhere in the excerpt.
    expect(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(out)).toBe(
      false,
    )
    expect(out).toContain('needle')
  })
})
