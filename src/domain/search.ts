/**
 * Global search over projects, tasks and milestones (client-side, whole workspace).
 * Case-insensitive, NFKC-normalised, works for CJK text (substring matching, no word
 * segmentation needed). Every whitespace-separated term must match.
 */
import type { Milestone, Project, Task, WorkspaceData } from './types'

export type SearchResult =
  | { kind: 'project'; id: string; score: number; project: Project }
  | { kind: 'task'; id: string; score: number; task: Task; project: Project; parent: Task | null }
  | { kind: 'milestone'; id: string; score: number; milestone: Milestone; project: Project }

const DEFAULT_LIMIT = 50

// Match tiers (higher is better). Penalties push done tasks below every open item and
// archived-project items below everything else, whatever their tier.
const SCORE_EXACT = 500
const SCORE_PREFIX = 400
const SCORE_WORD_PREFIX = 300
const SCORE_SUBSTRING = 200
const SCORE_DESCRIPTION = 100
const DONE_PENALTY = 1_000
const ARCHIVED_PENALTY = 2_000

const KIND_RANK: Record<SearchResult['kind'], number> = { project: 0, task: 1, milestone: 2 }

/** NFKC + lowercase + collapsed whitespace: the form queries and fields are compared in. */
export function normalizeSearchText(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

interface NormalizedFields {
  rawTitle: string
  rawDescription: string | null
  title: string
  description: string
}

// Entities are immutable store rows; caching their normalised text keeps typing fast.
// The raw values are kept so an entity mutated in place is still re-normalised.
const normalizedCache = new WeakMap<object, NormalizedFields>()

function fieldsOf(entity: object, title: string, description: string | null): NormalizedFields {
  const cached = normalizedCache.get(entity)
  if (cached && cached.rawTitle === title && cached.rawDescription === description) return cached
  const fields: NormalizedFields = {
    rawTitle: title,
    rawDescription: description,
    title: normalizeSearchText(title ?? ''),
    description: description ? normalizeSearchText(description) : '',
  }
  normalizedCache.set(entity, fields)
  return fields
}

// Combining marks (e.g. Devanagari vowel signs) continue the word of the letter before them.
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u
// Scripts written without spaces between words (incl. 'ー', '々'): switching to or from them
// starts a word ('準備demo', 'Q4報告'), but a CJK run itself has no detectable word starts.
const CJK_CHAR = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}\p{scx=Bopomofo}]/u

/** The whole code point that ends just before `index` (a surrogate pair counts as one). */
function codePointBefore(text: string, index: number): string {
  const low = text.charCodeAt(index - 1)
  if (low >= 0xdc00 && low <= 0xdfff && index >= 2) {
    const high = text.charCodeAt(index - 2)
    if (high >= 0xd800 && high <= 0xdbff) return text.slice(index - 2, index)
  }
  return text[index - 1]
}

/**
 * True when `term` occurs in `text` at the start of a word: at the very start, after a character
 * that is not a letter, digit or mark, or at a switch between CJK and other scripts.
 */
function hasWordPrefix(text: string, term: string): boolean {
  const termIsCJK = CJK_CHAR.test(String.fromCodePoint(term.codePointAt(0) as number))
  for (let i = text.indexOf(term); i !== -1; i = text.indexOf(term, i + 1)) {
    if (i === 0) return true
    const previous = codePointBefore(text, i)
    if (!WORD_CHAR.test(previous) || CJK_CHAR.test(previous) !== termIsCJK) return true
  }
  return false
}

/** Match score (0 = no match): every term must occur in the title or the description. */
function matchScore(fields: NormalizedFields, terms: readonly string[], phrase: string): number {
  let allInTitle = true
  for (const term of terms) {
    if (fields.title.includes(term)) continue
    if (!fields.description.includes(term)) return 0
    allInTitle = false
  }
  if (!allInTitle) return SCORE_DESCRIPTION
  if (fields.title === phrase) return SCORE_EXACT
  if (fields.title.startsWith(phrase)) return SCORE_PREFIX
  if (terms.every((term) => hasWordPrefix(fields.title, term))) return SCORE_WORD_PREFIX
  return SCORE_SUBSTRING
}

interface Ranked {
  result: SearchResult
  title: string
}

function compareRanked(a: Ranked, b: Ranked): number {
  return (
    b.result.score - a.result.score ||
    KIND_RANK[a.result.kind] - KIND_RANK[b.result.kind] ||
    a.title.length - b.title.length ||
    (a.title < b.title ? -1 : a.title > b.title ? 1 : 0) ||
    (a.result.id < b.result.id ? -1 : a.result.id > b.result.id ? 1 : 0)
  )
}

/**
 * Ranking (higher first): exact title > title prefix > word-prefix > title substring >
 * description-only match. Open tasks rank above done ones; items of archived projects rank
 * lowest. Empty query → []. Default limit 50.
 *
 * "Description-only" = at least one term matched only in the description. A word starts after a
 * space or punctuation, or where CJK meets another script ('準備demo', 'Q4報告'); inside a run of
 * CJK text every match is a substring match. The status rules outrank the match tier: every
 * open result comes before every done task, and everything in an archived project comes last.
 * Ties: projects, then tasks, then milestones; shorter titles first. Milestones match on name
 * only.
 */
export function searchWorkspace(
  data: WorkspaceData,
  query: string,
  options?: { limit?: number },
): SearchResult[] {
  const phrase = normalizeSearchText(typeof query === 'string' ? query : '')
  if (phrase === '') return []
  const terms = phrase.split(' ')
  const limit = options?.limit ?? DEFAULT_LIMIT
  if (!(limit > 0)) return []

  const projectOf = (projectId: string): Project | undefined =>
    Object.hasOwn(data.projects, projectId) ? data.projects[projectId] : undefined
  const ranked: Ranked[] = []

  for (const project of Object.values(data.projects)) {
    const fields = fieldsOf(project, project.name, project.description)
    let score = matchScore(fields, terms, phrase)
    if (score === 0) continue
    if (project.status === 'archived') score -= ARCHIVED_PENALTY
    ranked.push({
      result: { kind: 'project', id: project.id, score, project },
      title: fields.title,
    })
  }

  for (const task of Object.values(data.tasks)) {
    const project = projectOf(task.projectId)
    if (!project) continue
    const fields = fieldsOf(task, task.title, task.description)
    let score = matchScore(fields, terms, phrase)
    if (score === 0) continue
    if (task.status === 'done') score -= DONE_PENALTY
    if (project.status === 'archived') score -= ARCHIVED_PENALTY
    const parent =
      task.parentTaskId && Object.hasOwn(data.tasks, task.parentTaskId)
        ? data.tasks[task.parentTaskId]
        : null
    ranked.push({
      result: { kind: 'task', id: task.id, score, task, project, parent },
      title: fields.title,
    })
  }

  for (const milestone of Object.values(data.milestones)) {
    const project = projectOf(milestone.projectId)
    if (!project) continue
    const fields = fieldsOf(milestone, milestone.name, null)
    let score = matchScore(fields, terms, phrase)
    if (score === 0) continue
    if (project.status === 'archived') score -= ARCHIVED_PENALTY
    ranked.push({
      result: { kind: 'milestone', id: milestone.id, score, milestone, project },
      title: fields.title,
    })
  }

  ranked.sort(compareRanked)
  return ranked.slice(0, Math.floor(limit)).map((entry) => entry.result)
}
