/// <reference lib="dom" />
/**
 * Journey acceptance (local data mode): a Taiwanese graduate student runs a thesis project
 * (phases, subtasks, milestones, dependencies, Traditional Chinese titles), a flat side job and a
 * completed project over several simulated weeks (the clock is moved between days and the page
 * reloaded, the way the app is opened again the next day).
 *
 * After EVERY mutation an oracle derives the expected numbers from the stored workspace alone
 * (PRD §5: progress = done leaf tasks / leaf tasks; Today = due today, or scheduled across today
 * (start <= today < due), and not done; Overdue = due
 * before today and not done; Upcoming = due within the next 7 days) and every view must agree:
 * Overview, My Tasks tabs + sidebar badge, Projects list, project header, List, Board, Gantt and
 * Timeline. At the end the workspace is exported (JSON + CSV), imported into a fresh browser
 * context and compared.
 */
import {
  expect as baseExpect,
  test as base,
  type Download,
  type Locator,
  type Page,
} from '@playwright/test'

import { bar, moveBar } from './acceptance-gantt.helpers.ts'

const expect = baseExpect.configure({ timeout: 15_000 })

const KEY = 'cairn:local:workspace:v1'
const TZ = 'Asia/Taipei'
const STAMP = '2026-11-03T08:00:00.000Z'
const DAY1 = '2026-11-04'

const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = []
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(m.text())
      })
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
      await use(errors)
      expect(errors, 'console errors / uncaught exceptions').toEqual([])
    },
    { auto: true },
  ],
})
test.use({
  timezoneId: TZ,
  locale: 'en-US',
  viewport: { width: 1440, height: 900 },
  actionTimeout: 20_000,
})

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
const at = (iso: string) => new Date(`${iso}T10:00:00+08:00`)
const d = (n: number) => addDays(DAY1, n)

function dayPattern(date: string): RegExp {
  const [year, month, dom] = date.split('-').map(Number)
  const monthName = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  })
  const suffix =
    dom % 10 === 1 && dom !== 11
      ? 'st'
      : dom % 10 === 2 && dom !== 12
        ? 'nd'
        : dom % 10 === 3 && dom !== 13
          ? 'rd'
          : 'th'
  return new RegExp(`${monthName} ${dom}${suffix}, ${year}`)
}

// ---------------------------------------------------------------------------
// Seed: the student's workspace on Wed 2026-11-04
// ---------------------------------------------------------------------------

type Status = 'todo' | 'in_progress' | 'done'
interface SeedTask {
  id: string
  title: string
  phase?: string
  parent?: string
  status?: Status
  start?: number
  due?: number
  priority?: string
}

const THESIS = 'p-thesis'
const PHASES = [
  ['ph-lit', '文獻回顧'],
  ['ph-method', '研究方法'],
  ['ph-exp', '實驗與分析'],
  ['ph-write', '撰寫與口試'],
] as const

const THESIS_TASKS: SeedTask[] = [
  { id: 't-collect', title: '蒐集相關論文', phase: 'ph-lit', status: 'done', start: -25, due: -15 },
  {
    id: 't-litrev',
    title: '撰寫文獻回顧',
    phase: 'ph-lit',
    status: 'in_progress',
    start: -14,
    due: 6,
  },
  {
    id: 't-core20',
    title: '整理 20 篇核心論文',
    phase: 'ph-lit',
    parent: 't-litrev',
    status: 'done',
    start: -14,
    due: -3,
  },
  {
    id: 't-gap',
    title: '比較研究缺口',
    phase: 'ph-lit',
    parent: 't-litrev',
    status: 'in_progress',
    start: -2,
    due: 2,
  },
  { id: 't-ch2', title: '撰寫第二章初稿', phase: 'ph-lit', parent: 't-litrev', start: 1, due: 6 },
  { id: 't-survey', title: '設計問卷', phase: 'ph-method', start: 0, due: 4, priority: 'high' },
  {
    id: 't-irb',
    title: '取得 IRB 核可',
    phase: 'ph-method',
    start: 5,
    due: 12,
    priority: 'urgent',
  },
  { id: 't-recruit', title: '招募受試者', phase: 'ph-exp', start: 13, due: 25 },
  { id: 't-analysis', title: '資料分析', phase: 'ph-exp', start: 26, due: 40 },
  { id: 't-ch1', title: '撰寫第一章緒論', phase: 'ph-write', start: 0, due: 0, priority: 'medium' },
  { id: 't-advisor', title: '與指導教授討論進度', phase: 'ph-write', due: -1 },
  { id: 't-idea', title: '想到的點子' },
]

function seedWorkspace(): unknown {
  const projects: Record<string, unknown> = {}
  const phases: Record<string, unknown> = {}
  const tasks: Record<string, unknown> = {}
  const milestones: Record<string, unknown> = {}
  const dependencies: Record<string, unknown> = {}
  const project = (
    id: string,
    name: string,
    index: number,
    status = 'active',
    color = 'violet',
  ) => {
    projects[id] = {
      id,
      name,
      description: null,
      status,
      color,
      startDate: null,
      dueDate: null,
      scheduleMode: 'manual',
      sortOrder: `a${index}`,
      createdAt: STAMP,
      updatedAt: STAMP,
    }
  }
  project(THESIS, '碩士論文', 0)
  project('p-old', '大學專題', 1, 'completed', 'green')
  PHASES.forEach(([id, name], index) => {
    phases[id] = {
      id,
      projectId: THESIS,
      name,
      sortOrder: `a${index}`,
      createdAt: STAMP,
      updatedAt: STAMP,
    }
  })
  const addTask = (projectId: string, task: SeedTask, index: number) => {
    tasks[task.id] = {
      id: task.id,
      projectId,
      phaseId: task.phase ?? null,
      parentTaskId: task.parent ?? null,
      title: task.title,
      description: null,
      status: task.status ?? 'todo',
      priority: task.priority ?? 'none',
      startDate: task.start === undefined ? null : d(task.start),
      dueDate: task.due === undefined ? null : d(task.due),
      sortOrder: `a${index}`,
      completedAt: task.status === 'done' ? '2026-11-02T08:00:00.000Z' : null,
      createdAt: STAMP,
      updatedAt: STAMP,
    }
  }
  THESIS_TASKS.forEach((task, i) => addTask(THESIS, task, i))
  const old: SeedTask[] = [
    { id: 'o-1', title: '系統實作', status: 'done', start: -90, due: -60 },
    { id: 'o-2', title: '成果展示', status: 'done', start: -59, due: -40 },
  ]
  old.forEach((task, i) => addTask('p-old', task, i))
  const ms = (id: string, name: string, offset: number) => {
    milestones[id] = {
      id,
      projectId: THESIS,
      phaseId: null,
      name,
      date: d(offset),
      createdAt: STAMP,
      updatedAt: STAMP,
    }
  }
  ms('m-draft', '論文初稿繳交', 45)
  ms('m-oral', '口試申請截止', 70)
  const dep = (id: string, from: string, to: string) => {
    dependencies[id] = {
      id,
      projectId: THESIS,
      predecessorId: from,
      successorId: to,
      type: 'FS',
      createdAt: STAMP,
    }
  }
  dep('d-1', 't-survey', 't-irb')
  dep('d-2', 't-irb', 't-recruit')
  dep('d-3', 't-recruit', 't-analysis')
  return {
    version: 1,
    projects,
    phases,
    tasks,
    milestones,
    dependencies,
    preferences: { theme: 'light', sidebarCollapsed: false, timezone: TZ, weekStartsOn: 1 },
  }
}

// ---------------------------------------------------------------------------
// Stored workspace + oracle
// ---------------------------------------------------------------------------

interface StoredTask {
  id: string
  projectId: string
  phaseId: string | null
  parentTaskId: string | null
  title: string
  status: Status
  priority: string
  startDate: string | null
  dueDate: string | null
  completedAt: string | null
}
interface Db {
  projects: Record<string, { id: string; name: string; status: string }>
  phases: Record<string, { id: string; projectId: string; name: string }>
  tasks: Record<string, StoredTask>
  milestones: Record<string, { id: string; projectId: string; name: string; date: string }>
  dependencies: Record<string, { predecessorId: string; successorId: string }>
}

const readDb = (page: Page) =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}') as Db, KEY)

interface Expected {
  active: string[]
  progress: Record<string, string>
  open: number
  soon: number
  overdue: number
  /** Open tasks due today (the sidebar badge counts these). */
  today: string[]
  /** Open tasks with start <= today < due (My Tasks Today lists these after the due ones). */
  scheduledToday: string[]
  upcoming: string[]
  overdueTitles: string[]
  all: string[]
  board: Record<string, [number, number, number]>
}

function derive(db: Db, today: string): Expected {
  const projects = Object.values(db.projects)
  const tasks = Object.values(db.tasks)
  const parents = new Set(tasks.map((t) => t.parentTaskId).filter(Boolean))
  const live = new Set(projects.filter((p) => p.status !== 'archived').map((p) => p.id))
  const progress: Record<string, string> = {}
  const board: Expected['board'] = {}
  for (const p of projects) {
    const mine = tasks.filter((t) => t.projectId === p.id)
    const leaves = mine.filter((t) => !parents.has(t.id))
    const done = leaves.filter((t) => t.status === 'done').length
    progress[p.id] = leaves.length
      ? `${Math.floor((done * 100) / leaves.length)}% · ${done} of ${leaves.length} tasks done`
      : 'No tasks'
    // The Board shows top-level tasks only (docs/architecture.md), subtasks ride on the card.
    const top = mine.filter((t) => t.parentTaskId === null)
    board[p.id] = [
      top.filter((t) => t.status === 'todo').length,
      top.filter((t) => t.status === 'in_progress').length,
      top.filter((t) => t.status === 'done').length,
    ]
  }
  const open = tasks.filter((t) => live.has(t.projectId) && t.status !== 'done')
  const horizon = addDays(today, 7)
  const inWindow = (t: StoredTask) =>
    t.dueDate !== null && t.dueDate >= today && t.dueDate <= horizon
  return {
    active: projects.filter((p) => p.status === 'active').map((p) => p.id),
    progress,
    open: open.length,
    soon: open.filter(inWindow).length,
    overdue: open.filter((t) => t.dueDate !== null && t.dueDate < today).length,
    today: open.filter((t) => t.dueDate === today).map((t) => t.title),
    scheduledToday: open
      .filter((t) => t.startDate !== null && t.dueDate !== null)
      .filter((t) => t.startDate! <= today && today < t.dueDate!)
      .map((t) => t.title),
    upcoming: open.filter((t) => inWindow(t) && t.dueDate! > today).map((t) => t.title),
    overdueTitles: open.filter((t) => t.dueDate !== null && t.dueDate < today).map((t) => t.title),
    all: open.map((t) => t.title),
    board,
  }
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

const heading = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 })
const region = (page: Page, name: string) => page.getByRole('region', { name, exact: true })
const sidebar = (page: Page) => page.getByRole('complementary', { name: 'Sidebar' })
const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' })
const myTabs = (page: Page) => page.getByRole('navigation', { name: 'My Tasks' })
const header = (page: Page) => page.locator('[data-slot="page-header"]')
const toast = (page: Page, text: string | RegExp) =>
  page.locator('[data-sonner-toast]').filter({ hasText: text })

async function ready(page: Page): Promise<void> {
  await expect(sidebar(page)).toBeVisible()
  await expect(page.getByRole('main').locator('[aria-busy="true"]')).toHaveCount(0)
}

async function boot(page: Page, path: string, now: string, seed: unknown): Promise<void> {
  await page.clock.setFixedTime(at(now))
  if (seed) {
    await page.addInitScript(
      ({ k, db }) => {
        if (sessionStorage.getItem('cairn-journey-seeded')) return
        localStorage.setItem(k, JSON.stringify(db))
        sessionStorage.setItem('cairn-journey-seeded', '1')
      },
      { k: KEY, db: seed },
    )
  }
  await page.goto(path)
  await ready(page)
}

/** A new day: the clock moves and the app is opened again. */
async function nextDay(page: Page, now: string): Promise<void> {
  await page.clock.setFixedTime(at(now))
  await page.goto('/overview')
  await ready(page)
}

async function goVia(page: Page, link: 'Overview' | 'My Tasks' | 'Projects' | 'Timeline') {
  await mainNav(page).getByRole('link', { name: link }).click()
}

async function progressOf(scope: Locator, name: string): Promise<string> {
  const bar = scope.getByRole('progressbar', { name })
  if ((await bar.count()) === 0) return 'No tasks'
  return (await bar.getAttribute('aria-valuetext')) ?? '?'
}

async function expectProgress(scope: Locator, name: string, text: string, where: string) {
  await expect.poll(() => progressOf(scope, name), { message: `${where}: ${name}` }).toBe(text)
}

const rowTexts = (page: Page) =>
  page.locator('[data-task-row]').evaluateAll((rows) => rows.map((r) => r.textContent ?? ''))

async function expectRowsFor(page: Page, titles: string[], where: string) {
  await expect
    .poll(async () => (await rowTexts(page)).length, { message: `${where}: row count` })
    .toBe(titles.length)
  const texts = await rowTexts(page)
  for (const title of titles) {
    expect(
      texts.some((text) => text.includes(title)),
      `${where}: "${title}" is listed`,
    ).toBe(true)
  }
}

/** Every view must tell the story the stored workspace tells. `deep` reloads first. */
async function checkAll(page: Page, today: string, label: string, deep = false): Promise<Expected> {
  const started = Date.now()
  try {
    return await checkAllInner(page, today, label, deep)
  } finally {
    console.log(`checkAll ${label}: ${Date.now() - started} ms`)
  }
}

async function checkAllInner(
  page: Page,
  today: string,
  label: string,
  deep: boolean,
): Promise<Expected> {
  if (deep) {
    await page.reload()
    await ready(page)
  }
  const db = await readDb(page)
  const exp = derive(db, today)
  const name = (id: string) => db.projects[id].name

  // Overview
  await goVia(page, 'Overview')
  await expect(heading(page, 'Overview')).toBeVisible()
  await expect(page.locator('[data-metric="active"] dd'), `${label}: Overview active`).toHaveText(
    String(exp.active.length),
  )
  await expect(page.locator('[data-metric="open"] dd'), `${label}: Overview open`).toHaveText(
    String(exp.open),
  )
  await expect(page.locator('[data-metric="soon"] dd'), `${label}: Overview soon`).toHaveText(
    String(exp.soon),
  )
  await expect(page.locator('[data-metric="overdue"] dd'), `${label}: Overview overdue`).toHaveText(
    String(exp.overdue),
  )
  const activeSection = region(page, 'Active projects')
  for (const id of exp.active) {
    await expectProgress(
      activeSection,
      `${name(id)} progress`,
      exp.progress[id],
      `${label} Overview`,
    )
  }

  // My Tasks
  await goVia(page, 'My Tasks')
  await expect(myTabs(page).getByRole('link'), `${label}: My Tasks tabs`).toHaveText([
    new RegExp(`^Today\\s*${exp.today.length + exp.scheduledToday.length}\\b`),
    new RegExp(`^Upcoming\\s*${exp.upcoming.length}\\b`),
    new RegExp(`^Overdue\\s*${exp.overdue}\\b`),
    new RegExp(`^All Tasks\\s*${exp.open}\\b`),
  ])
  const due = exp.today.length + exp.overdue
  await expect(page.locator('a[href="/my-tasks"]'), `${label}: sidebar badge`).toHaveAccessibleName(
    due === 0
      ? /My Tasks$/
      : new RegExp(`${due} due today or overdue \\(${exp.overdue} overdue\\)`),
  )
  for (const [tab, titles] of (deep
    ? [
        ['Today', [...exp.today, ...exp.scheduledToday]],
        ['Upcoming', exp.upcoming],
        ['Overdue', exp.overdueTitles],
        ['All', exp.all],
      ]
    : [
        ['Today', [...exp.today, ...exp.scheduledToday]],
        ['All', exp.all],
      ]) as [string, string[]][]) {
    const link = myTabs(page).getByRole('link', { name: new RegExp(`^${tab}`) })
    await link.click()
    await expect(link).toHaveAttribute('aria-current', 'page')
    await expectRowsFor(page, titles, `${label}: My Tasks ${tab}`)
  }

  // Projects list
  if (deep) await page.goto('/projects?status=all')
  else await goVia(page, 'Projects')
  const table = page.getByRole('table', { name: 'Projects' })
  await expect(table).toBeVisible()
  const listed = deep ? Object.keys(db.projects) : exp.active
  for (const id of listed) {
    const row = table.getByRole('row').filter({
      has: page.getByRole('link', { name: name(id), exact: true }),
    })
    await expect(row, `${label}: Projects row ${name(id)}`).toHaveCount(1)
    await expectProgress(row, `${name(id)} progress`, exp.progress[id], `${label} Projects`)
  }

  // Each active project: header, List, Board, Gantt (Board and Gantt only at deep checkpoints)
  for (const id of exp.active) {
    await sidebar(page)
      .getByRole('link', { name: name(id), exact: true })
      .click()
    await expect(heading(page, name(id))).toBeVisible()
    // Only the project is marked as the current place in the sidebar, never Timeline or Overview.
    await expect(
      mainNav(page).locator('a[aria-current="page"]'),
      `${label}: no main nav item claims to be current on a project page`,
    ).toHaveCount(0)
    // The sidebar reopens the view this project was last on; the List is what is counted below.
    await page.getByRole('link', { name: 'List', exact: true }).click()
    await expectProgress(header(page), 'Project progress', exp.progress[id], `${label} header`)
    // Subtasks sit under their parent (collapsed or expanded): top-level rows are always there.
    const mine = Object.values(db.tasks).filter((t) => t.projectId === id)
    const topLevel = mine.filter((t) => t.parentTaskId === null).length
    if (mine.length > 0) {
      await expect
        .poll(async () => (await rowTexts(page)).length, {
          message: `${label}: List rows of ${name(id)}`,
        })
        .toBeGreaterThanOrEqual(topLevel)
      expect((await rowTexts(page)).length).toBeLessThanOrEqual(mine.length)
    }
    if (!deep) continue
    await page.getByRole('link', { name: 'Board', exact: true }).click()
    const [todo, doing, done] = exp.board[id]
    for (const [col, n] of [
      ['To Do', todo],
      ['In Progress', doing],
      ['Done', done],
    ] as const) {
      await expect(
        page.getByRole('region', { name: `${col} ${n} ${n === 1 ? 'task' : 'tasks'}` }),
        `${label}: Board ${name(id)} ${col}`,
      ).toBeVisible()
    }
    await page.getByRole('link', { name: 'Gantt', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Gantt chart' })).toBeVisible()
    await page.getByRole('link', { name: 'List', exact: true }).click()
  }

  // Timeline
  await goVia(page, 'Timeline')
  const chart = page.getByRole('region', { name: 'Timeline of all projects' })
  await expect(chart).toBeVisible()
  for (const id of exp.active) {
    const link = chart.getByRole('link', { name: name(id), exact: true })
    await expect(link, `${label}: Timeline row ${name(id)}`).toHaveCount(1)
    const m = /^(\d+)% · (\d+) of (\d+)/.exec(exp.progress[id])
    if (!m) await expect(link).toHaveAccessibleDescription(/No tasks/)
    else {
      await expect(link, `${label}: Timeline progress ${name(id)}`).toHaveAccessibleDescription(
        new RegExp(`${m[2]} of ${m[3]} tasks? done · ${m[1]}%`),
      )
    }
  }
  return exp
}

// ---------------------------------------------------------------------------
// Task Modal helpers
// ---------------------------------------------------------------------------

function idOf(db: Db, title: string): string {
  const ids = Object.values(db.tasks)
    .filter((t) => t.title === title)
    .map((t) => t.id)
  expect(ids, `exactly one stored task "${title}"`).toHaveLength(1)
  return ids[0]
}

async function openTask(page: Page, projectId: string, title: string): Promise<Locator> {
  const id = idOf(await readDb(page), title)
  await page.goto(`/projects/${projectId}/list?task=${id}`)
  const modal = page.getByRole('dialog', { name: `Edit task: ${title}` })
  await expect(modal).toBeVisible()
  return modal
}

async function setStatus(page: Page, modal: Locator, label: string) {
  await modal.getByRole('button', { name: /^Status:/ }).click()
  await page.getByRole('menuitemradio', { name: new RegExp(label) }).click()
}

/** Finish editing: the changes were saved as they were made, Done only closes the modal. */
async function save(page: Page, modal: Locator) {
  await modal.getByRole('button', { name: 'Done', exact: true }).click()
  await expect(page.locator('[role="dialog"]')).toHaveCount(0)
}

async function closeModal(page: Page, modal: Locator) {
  await modal.getByRole('button', { name: 'Close' }).click()
  await expect(page.locator('[role="dialog"]')).toHaveCount(0)
}

async function pickDate(
  page: Page,
  scope: Locator,
  field: 'Start date' | 'Due date' | 'Date',
  date: string,
) {
  await scope.getByRole('button', { name: new RegExp(`^${field}:`) }).click()
  const picker = page.getByRole('dialog', { name: field, exact: true })
  const target = picker.getByRole('button', { name: dayPattern(date) })
  for (let i = 0; i < 4 && (await target.count()) === 0; i++) {
    await picker.getByRole('button', { name: 'Go to the Next Month' }).click()
  }
  await target.click()
  await expect(picker).toBeHidden()
}

// ---------------------------------------------------------------------------
// Export / import helpers
// ---------------------------------------------------------------------------

async function readDownload(download: Download): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of await download.createReadStream()) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Everything a user can see, without ids (imports get new ids), sorted. */
function canon(db: Db): Record<string, string[]> {
  const project = (id: string) => db.projects[id]?.name ?? '?'
  const task = (id: string | null) => (id ? (db.tasks[id]?.title ?? '?') : '')
  const phase = (id: string | null) => (id ? (db.phases[id]?.name ?? '?') : '')
  return {
    projects: Object.values(db.projects)
      .map((p) => `${p.name}|${p.status}`)
      .sort(),
    phases: Object.values(db.phases)
      .map((p) => `${project(p.projectId)}|${p.name}`)
      .sort(),
    tasks: Object.values(db.tasks)
      .map((t) =>
        [
          project(t.projectId),
          phase(t.phaseId),
          task(t.parentTaskId),
          t.title,
          t.status,
          t.priority,
          t.startDate,
          t.dueDate,
          t.completedAt,
        ].join('|'),
      )
      .sort(),
    milestones: Object.values(db.milestones)
      .map((m) => `${project(m.projectId)}|${m.name}|${m.date}`)
      .sort(),
    dependencies: Object.values(db.dependencies)
      .map((x) => `${task(x.predecessorId)}->${task(x.successorId)}`)
      .sort(),
  }
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(field)
      field = ''
    } else if (c === '\r' && text[i + 1] === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      i++
    } else field += c
  }
  if (field || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

async function searchHits(page: Page, query: string): Promise<string[]> {
  await page
    .getByRole('banner')
    .getByRole('button', { name: /^Search/ })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Search' })
  await dialog.getByRole('combobox').fill(query)
  await expect(dialog.getByRole('combobox')).toHaveValue(query)
  await page.waitForTimeout(400)
  const hits = await dialog
    .getByRole('option')
    .evaluateAll((o) => o.map((x) => x.textContent ?? ''))
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  return hits
}

// ===========================================================================
// The journey
// ===========================================================================

/** Set to true to look at the pages (screenshots go to test-results/journey/). */
const SHOTS = false
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `test-results/journey/${name}.png` })
}

const SIDE = '接案：咖啡館網站'
const SIDE_RENAMED = '接案：咖啡館官網'

test.describe('journey: a thesis student over several weeks', () => {
  test.setTimeout(400_000)

  test('four weeks of real use: every view agrees after every change, then export and import', async ({
    page,
    browser,
  }) => {
    // ---- Day 1 (Wed 4 Nov): first look ----------------------------------------------------
    await boot(page, '/overview', DAY1, seedWorkspace())
    await checkAll(page, DAY1, 'D1 baseline', true)

    // 1a. Finish a subtask through its Task Modal.
    let modal = await openTask(page, THESIS, '比較研究缺口')
    await setStatus(page, modal, 'Done')
    await save(page, modal)
    await checkAll(page, DAY1, 'D1 subtask done')

    // 1b. A flat side-job project, built in the UI: dialog, then three inline tasks.
    await goVia(page, 'Projects')
    await page.getByRole('button', { name: 'New project' }).first().click()
    const dialog = page.getByRole('dialog', { name: 'New project' })
    await dialog.getByRole('textbox', { name: 'Name' }).fill(SIDE)
    await dialog.getByRole('button', { name: 'Create project' }).click()
    await expect(heading(page, SIDE)).toBeVisible()
    const first = page.getByRole('textbox', { name: 'Add your first task' })
    await first.fill('首頁設計')
    await first.press('Enter')
    await expect.poll(async () => Object.values((await readDb(page)).tasks).length).toBe(15)
    for (const title of ['客戶會議', '部署上線']) {
      const input = page.getByRole('textbox', { name: /^(New task|Add your first task)$/ })
      if ((await input.count()) === 0)
        await page.getByRole('button', { name: 'Add task', exact: true }).click()
      await page.getByRole('textbox', { name: /^(New task|Add your first task)$/ }).fill(title)
      await page.keyboard.press('Enter')
      await expect(page.locator('[data-task-row]').filter({ hasText: title })).toHaveCount(1)
    }
    await page.keyboard.press('Escape')
    const side = Object.values((await readDb(page)).projects).find((p) => p.name === SIDE)!.id
    await checkAll(page, DAY1, 'D1 side job created')

    // 1c. Dates and status for the side job.
    modal = await openTask(page, side, '客戶會議')
    await setStatus(page, modal, 'In Progress')
    await pickDate(page, modal, 'Due date', DAY1)
    await save(page, modal)
    modal = await openTask(page, side, '首頁設計')
    await pickDate(page, modal, 'Due date', d(3))
    await save(page, modal)
    const exp1 = await checkAll(page, DAY1, 'D1 side job dated')
    expect(exp1.today).toContain('客戶會議')
    expect(await searchHits(page, '問卷')).toEqual([expect.stringContaining('設計問卷')])

    // ---- Day 2 (Thu 5 Nov): the app is opened again ------------------------------------------
    await nextDay(page, d(1))
    const e2 = await checkAll(page, d(1), 'D2 reopened', true)
    expect(e2.overdueTitles).toContain('客戶會議') // due yesterday, not done
    modal = await openTask(page, THESIS, '與指導教授討論進度')
    await setStatus(page, modal, 'Done')
    await save(page, modal)
    await checkAll(page, d(1), 'D2 overdue task finished')
    {
      const done = (await readDb(page)).tasks[idOf(await readDb(page), '與指導教授討論進度')]
      expect(done.completedAt, 'completed on the app day (Taipei)').toMatch(new RegExp(`^${d(1)}T`))
    }
    modal = await openTask(page, side, '客戶會議')
    await pickDate(page, modal, 'Due date', d(3))
    await save(page, modal)
    await checkAll(page, d(1), 'D2 overdue task rescheduled')
    modal = await openTask(page, THESIS, '想到的點子')
    await pickDate(page, modal, 'Due date', d(1))
    await save(page, modal)
    await checkAll(page, d(1), 'D2 undated idea scheduled for today')

    // ---- Day 5 (Sun 8 Nov): the hierarchy changes --------------------------------------------
    await nextDay(page, d(4))
    await checkAll(page, d(4), 'D5 reopened', true)
    modal = await openTask(page, THESIS, '設計問卷')
    const subtasks = modal.getByRole('region', { name: 'Subtasks' })
    const add = subtasks.getByRole('textbox', { name: 'Add subtask' })
    for (const title of ['問卷初稿', '專家審閱']) {
      await add.fill(title)
      await add.press('Enter')
      await expect(subtasks.getByRole('button', { name: title, exact: true })).toBeVisible()
    }
    await closeModal(page, modal)
    await checkAll(page, d(4), 'D5 a leaf became a parent')
    modal = await openTask(page, THESIS, '設計問卷')
    await modal
      .getByRole('region', { name: 'Subtasks' })
      .getByRole('button', { name: 'Status of “問卷初稿”: To Do' })
      .click()
    await page.getByRole('menuitemradio', { name: /Done/ }).click()
    await expect
      .poll(async () => (await readDb(page)).tasks[idOf(await readDb(page), '問卷初稿')].status)
      .toBe('done')
    await closeModal(page, modal)
    await checkAll(page, d(4), 'D5 subtask finished')

    // Board: drag a card To Do -> In Progress -> Done with the real mouse.
    await sidebar(page).getByRole('link', { name: '碩士論文', exact: true }).click()
    await page.getByRole('link', { name: 'Board', exact: true }).click()
    const chapter = page.getByRole('button', { name: '撰寫第一章緒論', exact: true })
    for (const column of ['In Progress', 'Done']) {
      const target = page.getByRole('region', { name: new RegExp(`^${column} \\d+ tasks?$`) })
      const box = await target.boundingBox()
      const from = await chapter.boundingBox()
      expect(box && from).toBeTruthy()
      await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2)
      await page.mouse.down()
      await page.mouse.move(from!.x + 6, from!.y + 6, { steps: 3 })
      await page.mouse.move(box!.x + box!.width / 2, box!.y + 120, { steps: 12 })
      await page.mouse.up()
      const wanted = column === 'Done' ? 'done' : 'in_progress'
      await expect
        .poll(
          async () => (await readDb(page)).tasks[idOf(await readDb(page), '撰寫第一章緒論')].status,
        )
        .toBe(wanted)
      await checkAll(page, d(4), `D5 board drag to ${column}`)
      await sidebar(page).getByRole('link', { name: '碩士論文', exact: true }).click()
      await page.getByRole('link', { name: 'Board', exact: true }).click()
    }
    {
      const done = (await readDb(page)).tasks[idOf(await readDb(page), '撰寫第一章緒論')]
      expect(done.completedAt, 'a task dragged to Done is stamped completed').not.toBeNull()
    }

    modal = await openTask(page, THESIS, '想到的點子')
    await modal.getByRole('textbox', { name: 'Task title' }).fill('研究動機補充')
    await save(page, modal)
    await checkAll(page, d(4), 'D5 renamed')
    expect(await searchHits(page, '研究動機')).toHaveLength(1)
    expect(await searchHits(page, '想到的點子')).toHaveLength(0)

    modal = await openTask(page, THESIS, '撰寫第二章初稿')
    await modal.getByRole('button', { name: 'More actions' }).click()
    await page.getByRole('menuitem', { name: /Delete task/ }).click()
    await page
      .getByRole('alertdialog', { name: 'Delete task?' })
      .getByRole('button', { name: 'Delete' })
      .click()
    await expect(page.locator('[role="dialog"], [role="alertdialog"]')).toHaveCount(0)
    await checkAll(page, d(4), 'D5 subtask deleted')
    expect(await searchHits(page, '第二章')).toHaveLength(0)

    // ---- Day 12 (Sun 15 Nov): a milestone, and the other subtask ------------------------------
    await nextDay(page, d(11))
    await checkAll(page, d(11), 'D12 reopened', true)
    await sidebar(page).getByRole('link', { name: '碩士論文', exact: true }).click()
    await page.getByRole('button', { name: 'Project actions' }).click()
    await page.getByRole('menuitem', { name: /Add milestone/ }).click()
    const ms = page.getByRole('dialog', { name: 'New milestone' })
    await ms.getByRole('textbox', { name: 'Name' }).fill('期中口試預審')
    await pickDate(page, ms, 'Date', d(20))
    await ms.getByRole('button', { name: 'Create milestone' }).click()
    await expect(ms).toBeHidden()
    expect(Object.values((await readDb(page)).milestones).map((m) => m.name)).toContain(
      '期中口試預審',
    )
    await checkAll(page, d(11), 'D12 milestone added')
    await goVia(page, 'Overview')
    await expect(region(page, 'Upcoming milestones')).toContainText('期中口試預審')
    expect(await searchHits(page, '期中口試')).toHaveLength(1)

    // The side job gets a better name; a finished chapter is reopened.
    await goVia(page, 'Projects')
    await page
      .getByRole('table', { name: 'Projects' })
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: SIDE, exact: true }) })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Edit project…' }).click()
    const editProject = page.getByRole('dialog', { name: 'Edit project' })
    await editProject.getByRole('textbox', { name: 'Name' }).fill(SIDE_RENAMED)
    await editProject.getByRole('button', { name: 'Save changes' }).click()
    await expect(editProject).toBeHidden()
    await checkAll(page, d(11), 'D12 project renamed')
    expect(await searchHits(page, '咖啡館官網')).toHaveLength(1)
    expect(await searchHits(page, '咖啡館網站')).toHaveLength(0)
    modal = await openTask(page, THESIS, '撰寫第一章緒論')
    await setStatus(page, modal, 'To Do')
    await save(page, modal)
    {
      const reopened = (await readDb(page)).tasks[idOf(await readDb(page), '撰寫第一章緒論')]
      expect(reopened.status).toBe('todo')
      expect(reopened.completedAt, 'a reopened task is no longer completed').toBeNull()
    }
    await checkAll(page, d(11), 'D12 done task reopened')

    // Gantt: slide the IRB bar three days later with the mouse; the dates follow everywhere.
    const irb = idOf(await readDb(page), '取得 IRB 核可')
    const before = (await readDb(page)).tasks[irb]
    await sidebar(page).getByRole('link', { name: '碩士論文', exact: true }).click()
    await page.getByRole('link', { name: 'Gantt', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Gantt chart' })).toBeVisible()
    await page.getByRole('radio', { name: 'Day' }).click()
    await expect(bar(page, irb)).toBeVisible()
    await moveBar(page, irb, 3, 'day')
    await expect
      .poll(async () => (await readDb(page)).tasks[irb].dueDate)
      .toBe(addDays(before.dueDate!, 3))
    expect((await readDb(page)).tasks[irb].startDate).toBe(addDays(before.startDate!, 3))
    await checkAll(page, d(11), 'D12 Gantt drag')

    // The thesis moves to Auto scheduling; a later IRB date pushes everything behind it.
    await sidebar(page).getByRole('link', { name: '碩士論文', exact: true }).click()
    await page.getByRole('link', { name: 'Gantt', exact: true }).click()
    await page.getByRole('button', { name: 'Dependencies: Manual' }).click()
    await page.getByRole('menuitemradio', { name: /^Auto/ }).click()
    await expect(page.getByRole('button', { name: 'Dependencies: Auto' })).toBeVisible()
    const shiftDialog = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    if (await shiftDialog.isVisible().catch(() => false)) {
      console.log('NOTE switching to Auto offers a shift preview')
      await shiftDialog.getByRole('button', { name: /^Apply/ }).click()
    }
    await checkAll(page, d(11), 'D12 Auto mode on')
    modal = await openTask(page, THESIS, '取得 IRB 核可')
    await pickDate(page, modal, 'Due date', addDays((await readDb(page)).tasks[irb].dueDate!, 4))
    // Auto mode: the preview appears right after the pick, no Save in between.
    const preview = page.getByRole('dialog', { name: 'Move dependent tasks?' })
    await expect(preview).toBeVisible()
    await preview.getByRole('button', { name: /^Apply/ }).click()
    await expect(preview).toBeHidden()
    await modal.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(page.locator('[role="dialog"]')).toHaveCount(0)
    {
      const db = await readDb(page)
      for (const link of Object.values(db.dependencies)) {
        const from = db.tasks[link.predecessorId]
        const to = db.tasks[link.successorId]
        if (from.dueDate && to.startDate) {
          expect(
            to.startDate > from.dueDate,
            `Auto: "${to.title}" starts after "${from.title}" ends`,
          ).toBe(true)
        }
      }
    }
    await checkAll(page, d(11), 'D12 Auto shift applied')
    await shot(page, 'gantt')
    await sidebar(page).getByRole('link', { name: '碩士論文', exact: true }).click()
    await page.getByRole('link', { name: 'List', exact: true }).click()
    await expect(page.locator('[data-task-row]').first()).toBeVisible()
    await shot(page, 'list')
    await goVia(page, 'Overview')
    await expect(heading(page, 'Overview')).toBeVisible()
    await shot(page, 'overview')
    await goVia(page, 'My Tasks')
    await shot(page, 'mytasks')
    await goVia(page, 'Timeline')
    await shot(page, 'timeline')

    modal = await openTask(page, THESIS, '設計問卷')
    await modal
      .getByRole('region', { name: 'Subtasks' })
      .getByRole('button', { name: 'Status of “專家審閱”: To Do' })
      .click()
    await page.getByRole('menuitemradio', { name: /Done/ }).click()
    await expect
      .poll(async () => (await readDb(page)).tasks[idOf(await readDb(page), '專家審閱')].status)
      .toBe('done')
    await closeModal(page, modal)
    await checkAll(page, d(11), 'D12 all subtasks of a parent done')

    // ---- Day 20 (Tue 24 Nov): the side job wraps up -------------------------------------------
    await nextDay(page, d(20))
    await checkAll(page, d(20), 'D20 reopened', true)
    for (const title of ['首頁設計', '客戶會議']) {
      modal = await openTask(page, side, title)
      await setStatus(page, modal, 'Done')
      await save(page, modal)
    }
    await checkAll(page, d(20), 'D20 two of three side-job tasks done')
    await goVia(page, 'Projects')
    await page
      .getByRole('table', { name: 'Projects' })
      .getByRole('row')
      .filter({
        has: page.getByRole('link', { name: SIDE_RENAMED, exact: true }),
      })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark completed' }).click()
    await expect(toast(page, 'Project marked completed')).toBeVisible()
    await checkAll(page, d(20), 'D20 side job completed with one open task')

    // ---- Day 27 (Tue 1 Dec): archive the old project, then back up ----------------------------
    await nextDay(page, d(27))
    await checkAll(page, d(27), 'D27 reopened', true)

    // The side job is archived: it leaves every view and its open task leaves My Tasks.
    await page.goto('/projects?status=all')
    await ready(page)
    await shot(page, 'projects')
    await page
      .getByRole('table', { name: 'Projects' })
      .getByRole('row')
      .filter({ has: page.getByRole('link', { name: SIDE_RENAMED, exact: true }) })
      .click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Archive' }).click()
    await expect(toast(page, /archived/i)).toBeVisible()
    const e27 = await checkAll(page, d(27), 'D27 side job archived')
    await sidebar(page).getByRole('link', { name: THESIS_NAME, exact: true }).click()
    await shot(page, 'after-archive')
    expect(e27.all).not.toContain('部署上線')
    const archivedHits = await searchHits(page, '部署上線')
    expect(archivedHits).toHaveLength(1)
    expect(archivedHits[0]).toMatch(/Archived/)

    await page.goto('/settings/data')
    await ready(page)
    await shot(page, 'settings-data')
    const [jsonDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export JSON backup' }).click(),
    ])
    const backup = await readDownload(jsonDownload)
    const [csvDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Export tasks CSV' }).click(),
    ])
    const csv = await readDownload(csvDownload)
    const finalDb = await readDb(page)

    // CSV: BOM, header, one row per task, subtasks name their parent, Chinese intact.
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    const rows = parseCsv(csv.slice(1)).filter((r) => r.length > 1 || r[0] !== '')
    expect(rows[0]).toEqual([
      'Project',
      'Phase',
      'Parent task',
      'Title',
      'Status',
      'Priority',
      'Start',
      'Due',
      'Completed at',
      'Description',
    ])
    expect(rows.length - 1).toBe(Object.keys(finalDb.tasks).length)
    const labels = { todo: 'To Do', in_progress: 'In Progress', done: 'Done' } as const
    for (const t of Object.values(finalDb.tasks)) {
      const row = rows.find((r) => r[3] === t.title && r[0] === finalDb.projects[t.projectId].name)
      expect(row, `CSV row for ${t.title}`).toBeTruthy()
      expect(row![4]).toBe(labels[t.status])
      expect(row![6]).toBe(t.startDate ?? '')
      expect(row![7]).toBe(t.dueDate ?? '')
      expect(row![2]).toBe(t.parentTaskId ? finalDb.tasks[t.parentTaskId].title : '')
      expect(row![1]).toBe(t.phaseId ? finalDb.phases[t.phaseId].name : '')
    }

    // ---- A fresh browser: import the backup, everything is the same ---------------------------
    const context = await browser.newContext({
      timezoneId: TZ,
      locale: 'en-US',
      viewport: { width: 1440, height: 900 },
    })
    const fresh = await context.newPage()
    const errors: string[] = []
    fresh.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    fresh.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
    await fresh.clock.setFixedTime(at(d(27)))
    await fresh.goto('/settings/data')
    await ready(fresh)
    await fresh.getByLabel('Backup file').setInputFiles({
      name: 'backup.json',
      mimeType: 'application/json',
      buffer: Buffer.from(backup),
    })
    const importDialog = fresh.getByRole('dialog', { name: 'Import backup' })
    await expect(importDialog).toBeVisible()
    await shot(fresh, 'import-dialog')
    await importDialog.getByRole('button', { name: 'Import as new copies' }).click()
    await expect(importDialog).toBeHidden()
    const importedDb = await readDb(fresh)
    expect(canon(importedDb)).toEqual(canon(finalDb))
    await checkAll(fresh, d(27), 'imported workspace', true)
    expect(errors).toEqual([])
    await context.close()
  })
})

test.describe('journey: small frictions a real user meets', () => {
  test.setTimeout(120_000)

  test('dates cannot cross, a task needs a project, completing a project with open tasks is undoable', async ({
    page,
  }) => {
    await boot(page, '/overview', DAY1, seedWorkspace())

    // A due date before the start date is not offered by the calendar at all.
    const modal = await openTask(page, THESIS, '設計問卷')
    await modal.getByRole('button', { name: /^Due date:/ }).click()
    const picker = page.getByRole('dialog', { name: 'Due date', exact: true })
    await expect(picker.getByRole('button', { name: dayPattern(d(-1)) })).toBeDisabled()
    await expect(picker.getByRole('button', { name: dayPattern(d(1)) })).toBeEnabled()
    await page.keyboard.press('Escape')
    await closeModal(page, modal)

    // "New task" from the Overview must be told which project; until then Create is disabled.
    await page.goto('/overview')
    await ready(page)
    await page.getByRole('button', { name: 'New task' }).first().click()
    const created = page.getByRole('dialog', { name: 'New task', exact: true })
    await expect(created).toContainText('Choose a project to create this task.')
    await expect(created.getByRole('button', { name: 'Create task' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(created).toBeHidden()

    // A project with open tasks can be marked completed; the toast offers Undo and it works.
    await page.goto('/projects')
    await ready(page)
    const row = page
      .getByRole('table', { name: 'Projects' })
      .getByRole('row')
      .filter({
        has: page.getByRole('link', { name: THESIS_NAME, exact: true }),
      })
    await row.click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Mark completed' }).click()
    const done = toast(page, 'Project marked completed')
    await expect(done).toBeVisible()
    await expect(row).toHaveCount(0) // it left the Active list
    await done.getByRole('button', { name: 'Undo' }).click()
    await expect(row).toHaveCount(1)
    await expect.poll(async () => (await readDb(page)).projects[THESIS].status).toBe('active')
    await checkAll(page, DAY1, 'completed and undone', true)
  })
})
const THESIS_NAME = '碩士論文'
