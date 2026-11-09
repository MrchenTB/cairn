# Cairn — Architecture & Engineering Contract

> Product: **Cairn** — "Plan clearly. Work simply." A desktop-first, single-user project manager
> (List / Board / Gantt over one task model) with cloud sync via Supabase.
> Source of truth for product requirements: the PRD (`Personal_Project_Manager_PRD_Claude_Code.md`).
> This file is the **engineering contract** every contributor builds against. When code and this
> file disagree, fix one of them deliberately — never silently drift.
>
> **Where decisions go.** This file states the rules as they are. Why a rule was chosen (and what was
> given up) is recorded in `docs/decisions.md` as numbered entries (D1…D32 so far). A new trade-off
> gets the next number (D33, …) with background → decision → reason/trade-off; if it changes a rule
> described here, update this file in the same change and cite the number. Current completion,
> test results and known limitations live in `docs/progress.md`.

## 1. Stack (installed versions)

| Concern     | Choice                                                                                                                                                                                                                       | Notes                                          |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Build       | Vite 8 (Rolldown/Oxc), `@vitejs/plugin-react` 6                                                                                                                                                                              | alias `@` → `src`                              |
| Language    | TypeScript **7** (native compiler, `tsc -b`), strict                                                                                                                                                                         | no `baseUrl` (removed); `paths` only           |
| UI          | React 19.3, Tailwind CSS 4.3 (`@tailwindcss/vite`), `radix-ui` 1.8 (unified package), shadcn-style components we own, `lucide-react` 1.x, `cmdk`, `sonner`, `react-day-picker` 10, `tw-animate-css`, `motion` 14 (sparingly) |                                                |
| Routing     | `react-router` **8**                                                                                                                                                                                                         | import from `react-router`                     |
| State       | `zustand` 5 + `immer` 11 (patches for rollback)                                                                                                                                                                              |                                                |
| DnD         | `@dnd-kit/core` 6.3 + `@dnd-kit/sortable` 10 (List/Board); custom pointer events (Gantt)                                                                                                                                     |                                                |
| Ordering    | `fractional-indexing` 4                                                                                                                                                                                                      | via `src/domain/ordering.ts` only              |
| Validation  | `zod` 4                                                                                                                                                                                                                      | via `src/domain/validation.ts`                 |
| Backend     | Supabase Auth + Postgres + RLS via `@supabase/supabase-js` 2                                                                                                                                                                 | no app server                                  |
| Tests       | Vitest 5 (+ jsdom, Testing Library, jest-dom 7), PGlite (DB/RLS), Playwright 1.64 (E2E; Chromium only so far), local Supabase simulator (`tests/cloud-sim`)                                                                  |                                                |
| Lint/format | oxlint, prettier (no semicolons, single quotes, width 100)                                                                                                                                                                   |                                                |
| Hosting     | Vercel (static SPA, `vercel.json`: security headers + SPA fallback that excludes `/assets/`)                                                                                                                                 | see docs/platform-notes.md, docs/deployment.md |

**Several majors are newer than most training data** (react-router 8, react-day-picker 10, zod 4,
immer 11, lucide-react 1.x, TypeScript 7, Vitest 5, jest-dom 7). Before using an API you are not
sure about, read the installed package's `.d.ts` / README under `node_modules/`.
Node: `package.json` `engines` is `24.x`; `.node-version` pins 24.

## 2. Repository layout & ownership

```
src/
  main.tsx, App.tsx, index.css
  app/            shell, router, providers, auth gate, login, shortcuts, uiStore, taskModalRoute, viewPrefs
  components/
    ui/           generic primitives (Button, Dialog, DropdownMenu, Popover, Tooltip, Input, …)
    task/         task primitives (StatusIcon, PriorityIcon, StatusMenu, PriorityMenu, DateField, ProjectDot, ProgressBar, DueLabel)
    layout/       PageHeader, EmptyState, etc.
    brand/        Logo
  domain/         PURE TypeScript (no React, no I/O) + unit tests (*.test.ts)
  data/           repositories, auth, store, hooks, backup/export
  features/
    overview/ my-tasks/ projects/ list/ board/ gantt/ timeline/ task-modal/ milestones/ search/ settings/
  lib/            utils (cn), notify, keyboard helpers
  styles/         tokens.css and theme layers
  test/           vitest setup
supabase/         migrations/*.sql, config.toml
tests/db/         PGlite migration + RLS tests (vitest project "db")
tests/cloud-sim/  local stand-in for a Supabase project (tests only; src/ must never import it), see its README
e2e/              Playwright specs (local data mode)
e2e-cloud/        Playwright specs (cloud mode against the local simulator in tests/cloud-sim)
e2e-prod/         Playwright specs (production builds behind vercel.json)
docs/             architecture.md (this), decisions.md, progress.md, deployment.md, design-research.md, gantt-evaluation.md, platform-notes.md
```

Parallel work is split by **folder ownership**; each task brief states what you own. Outside your
folders: read freely, change only with a minimal, clearly reported edit (bug fix / additive export).
Frozen contracts (change only if unavoidable, and report it): `src/domain/types.ts`,
`src/data/contracts.ts`, `src/app/uiStore.ts` public API, `src/data/hooks.ts` existing exports.

## 3. Conventions

- Code style: prettier config in repo (no semicolons, single quotes). Named exports. Imports via `@/…`.
- Comment density: short JSDoc on exported functions/types, comments only for non-obvious logic.
- UI copy is **English** (matches PRD wireframes); content may be any language → font stack covers CJK.
  User-facing docs (README, guides) are Traditional Chinese.
- Accessibility: every interactive element reachable by keyboard, visible focus ring
  (`--focus-ring`), Radix primitives for menus/dialogs/popovers (focus trap, Esc), `aria-label` on
  icon-only buttons, never convey status by color alone (icons + text/tooltip).
- Respect `prefers-reduced-motion` (Tailwind `motion-safe:` / `motion-reduce:`).
- No `localeCompare` for sortOrder keys. No `new Date('YYYY-MM-DD')` anywhere (UTC parse → off-by-one);
  use `src/domain/dates.ts`.
- Never commit secrets. Only `VITE_SUPABASE_URL` and the **publishable/anon** key reach the browser.

## 4. Data model

TypeScript: `src/domain/types.ts` (camelCase). Postgres: snake_case. Mapping lives only in the
Supabase repository mappers.

### 4.1 Tables (schema `public`)

All tables: `user_id uuid not null default auth.uid()`, RLS enabled, policies
`to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id)`
for select/insert/update/delete. `anon` and `public` get no privileges; `authenticated` gets
`select, insert, update, delete`. `updated_at` maintained by trigger.

| Table               | Columns                                                                                                                                                                                                                                                                                                                                                                         | Key constraints                                                                                                                                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `projects`          | id uuid pk, user_id → auth.users (cascade), name text (1..200 trimmed), description text null (≤10000), status text ('active','completed','archived') default 'active', color text (ProjectColor) default 'gray', start_date date null, due_date date null, schedule_mode text ('manual','auto') default 'manual', sort_order text collate "C" not null, created_at, updated_at | due ≥ start; `unique (id, user_id)`                                                                                                                                                                                                                                 |
| `phases`            | id, user_id, project_id, name (1..200), sort_order text collate "C", created_at, updated_at                                                                                                                                                                                                                                                                                     | FK (project_id, user_id) → projects(id, user_id) on delete cascade; `unique (id, project_id)`                                                                                                                                                                       |
| `tasks`             | id, user_id, project_id, phase_id null, parent_task_id null, title (1..500), description null (≤10000), status ('todo','in_progress','done') default 'todo', priority ('none','low','medium','high','urgent') default 'none', start_date null, due_date null, sort_order text collate "C", completed_at timestamptz null, created_at, updated_at                                | FK (project_id, user_id) → projects cascade; FK (phase_id, project_id) → phases(id, project_id) **on delete set null (phase_id)**; FK (parent_task_id, project_id) → tasks(id, project_id) on delete cascade; `unique (id, project_id)`; due ≥ start; parent ≠ self |
| `milestones`        | id, user_id, project_id, phase_id null, name (1..200), date date not null, created_at, updated_at                                                                                                                                                                                                                                                                               | FK (project_id, user_id) → projects cascade; FK (phase_id, project_id) → phases on delete set null (phase_id)                                                                                                                                                       |
| `task_dependencies` | id, user_id, project_id, predecessor_id, successor_id, type text default 'FS' check = 'FS', created_at                                                                                                                                                                                                                                                                          | FK (project_id, user_id) → projects cascade; FK (predecessor_id, project_id) and (successor_id, project_id) → tasks(id, project_id) cascade; `unique (predecessor_id, successor_id)`; pred ≠ succ                                                                   |
| `user_preferences`  | user_id uuid pk default auth.uid() → auth.users cascade, theme text ('system','light','dark'), sidebar_collapsed bool, timezone text, week_starts_on smallint (0/1), created_at, updated_at                                                                                                                                                                                     | one row per user                                                                                                                                                                                                                                                    |

Composite FKs make cross-user and cross-project references impossible even though FK checks bypass RLS.

### 4.2 Triggers (server-side integrity, mirrored by LocalRepository)

- `updated_at` on every update.
- tasks `completed_at`: set to now() when status becomes 'done', null when it leaves 'done'.
- tasks hierarchy: parent must be top-level (parent.parent_task_id is null); a task that has subtasks
  cannot get a parent; `project_id` and `user_id` are immutable on update (moving tasks across projects
  is out of scope for V1).
- subtask phase: a subtask's phase_id is forced to its parent's phase_id; when a parent's phase_id
  changes, its subtasks follow.
- task_dependencies: reject cycles (recursive CTE), reject parent↔own-subtask edges.

### 4.3 RPC functions (`security invoker`, `set search_path = ''`, EXECUTE only for `authenticated`)

| Function                                                                                                         | Purpose                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply_task_schedule(p_changes jsonb) returns setof public.tasks`                                                | `[{"id","start_date","due_date"}]` — all-or-nothing; raises if any id is missing/not owned or dates invalid                                                                                         |
| `delete_task(p_task_id uuid, p_keep_subtasks boolean default false, p_promoted jsonb default '[]') returns void` | keep=false → delete (subtasks cascade). keep=true → each `{"id","sort_order"}` in p_promoted becomes top-level with that sort_order, then the parent is deleted. Atomic.                            |
| `import_workspace(p_data jsonb) returns jsonb`                                                                   | `{"projects":[…],"phases":[…],"tasks":[…],"milestones":[…],"dependencies":[…]}` rows in snake_case (ids already fresh, no user_id) → inserted in one transaction; returns counts `{"projects":n,…}` |

Everything else is plain PostgREST table CRUD (`.from(table).insert/update/delete/select`).
Loading uses `.range()` pagination (PostgREST max rows = 1000 per request).

## 5. Domain rules (implemented once in `src/domain/*`)

- **Dates** — `ISODate` strings; inclusive ranges; continuous calendar days; helpers in `dates.ts`.
- **Today** — `todayInTimeZone(preferences.timezone)`; React: `useToday()`. Default time zone =
  browser zone at first run (saved to preferences so all devices agree), fallback `Asia/Taipei`.
- **Buckets** (`buckets.ts`) — population = tasks of any level in non-archived projects.
  Overdue = open & due < today · Today = open & due == today · Upcoming = open & today < due ≤ today+7 ·
  done tasks are never overdue. Overview "Due soon" = Today + Upcoming; "Open tasks" = open tasks.
- **Progress** (`progress.ts`) — completed leaf tasks / leaf tasks; milestones never count; no tasks → "No tasks".
- **Hierarchy** (`hierarchy.ts`) — Project → optional Phase → Task → optional one level of Subtask.
  Outline groups: null-phase group first, then phases in order; milestones listed inside their group by date.
- **Ordering** (`ordering.ts`) — fractional keys. Ordering spaces: projects (global), phases (per project),
  top-level tasks (**one space per project across phases and statuses**), subtasks (per parent).
  List groups and Board columns show subsequences of the same order, so "insert between neighbours" is
  always valid. Board shows top-level tasks only (with a subtask count chip).
- **Scheduling** (`scheduling.ts`) — see header comment there: FS with bounds for partial dates;
  conflicts = certain violations only; auto-schedule pushes successors later only, preserves duration,
  never moves the user's explicitly edited tasks; dependencies are task↔task in one project only;
  constraints do not pass through tasks without their own dates (including rollup-only parents); see decisions D16.
- **Search** (`search.ts`) — projects, tasks, milestones; client-side over the loaded workspace.
- **Validation** (`validation.ts`) — names/titles, date ranges, descriptions, backup files.

## 6. Data layer

- `src/data/contracts.ts` — `Repository`, `AuthService`, store state/actions (read the JSDoc rules).
- Mode selection (`src/data/config.ts`): Supabase mode when `VITE_SUPABASE_URL` and
  `VITE_SUPABASE_PUBLISHABLE_KEY` (or legacy `VITE_SUPABASE_ANON_KEY`) are set, unless
  `VITE_DATA_MODE=local`. Otherwise **local mode**: data in `localStorage` of this browser only, no
  login, and the UI always shows a "Local only — not synced" indicator. Local mode exists so the app
  runs and E2E-tests without keys; it is never presented as cloud sync.
- Store (`src/data/store.ts`): zustand + immer. Optimistic update → repository call → reconcile or
  rollback (inverse patches) + toast with Retry. `sync` state drives the sidebar indicator
  ("Saving…", "Saved", "Couldn't save · Retry", "Offline", "Local only").
- Cross-device freshness: `refresh({ silent: true })` on window focus / visibility / coming back online
  (throttled to 30 s, `AUTO_REFRESH_INTERVAL_MS`; skipped while writes are pending; a refresh started
  before a write is discarded). This is refresh-on-return, **not** live push: another device that stays
  in the foreground shows changes only after focus or reload. While a schedule preview is open the
  throttle is bypassed on focus (decision D15). A refresh the server refuses (auth) re-checks the
  session instead of silently showing old data.
- Network deadline: `src/data/supabaseClient.ts` gives the Supabase client a custom `fetch`
  (`fetchWithDeadline`): every request, including a response body that never finishes, is aborted
  after `REQUEST_TIMEOUT_MS` (30 s) so a hung request cannot block the write queue or a form; the
  caller's own abort passes through.
- Feedback rules: a successful Retry shows one generic "Saved" toast (D13). In cloud mode, closing or
  reloading the tab while `sync.pending > 0` or a failed write waits for Retry asks first, and in both
  modes while task text is unsaved (`UnsavedWritesGuard`, D14, D28); it is not an offline queue and
  lost writes are not re-sent.
- Write options: `updateTask` and `applySchedule` take an optional `WriteOptions` (`label` for the
  failure toast's title, `secondaryAction` for a second button); their Retry keeps them.
  `withdrawFailedChanges(taskId, fields)` withdraws a failed change the user gave up on without
  writing anything (typing the stored value back, discarding a draft).
- Task Modal autosave (`src/features/task-modal/autosave/`, D26–D30): `textDraft.ts` is one text
  field's rules (no React, no store: debounce, max-wait, IME gate, coalescing, failure); `draftManager.ts`
  keeps drafts per task and field beyond the modal's life, mirrors them to `sessionStorage` and
  isolates accounts; `taskDrafts.ts` wires the app's instance to the stores; `useTaskAutosave.ts`
  binds the form. Every write still goes through the store (or the planner); nothing here talks to
  a repository. `sessionStorage` is a safety net for this tab, not a backup.
- Hooks (`src/data/hooks.ts`): `useProjects`, `useProject`, `usePhases`, `useProjectTasks`, `useTask`,
  `useSubtasks`, `useMilestones`, `useMilestone`, `useDependencies`, `useWorkspaceData`, `usePreferences`,
  `useSyncState`, `useActions`, `useAuth`, `useToday`, `useWorkspaceStatus`, `useDataMode`.
  Non-hook: `getWorkspaceActions()` from `src/data/store.ts`.
- Test hooks (local mode; installed only when `import.meta.env.DEV` or Vite mode `e2e`, and absent from normal production bundles): `window.__cairnTest = { failNextWrites(n), setLatency(ms), reset() }`.
- Backup: JSON export of everything (+ preferences), CSV export of tasks; import = validated
  (`parseBackupFile`), ids remapped, inserted atomically as new copies.
  The JSON export is built from the saved data (`exportSavedBackup()`: waits for pending writes, then re-reads the
  workspace through the write queue), never from unconfirmed screen state; once that read has its answer, Settings asks before
  downloading when a failed write or unsaved task text is waiting (D36).

## 7. App shell, routing, UI contracts

Routes (react-router 8, browser history; Vercel SPA fallback):

```
/login                         sign-in / sign-up (Supabase mode; local mode redirects to /overview)
/                              → /overview
/overview                      features/overview/OverviewPage
/my-tasks/:tab                 features/my-tasks/MyTasksPage   (today | upcoming | overdue | all; /my-tasks → today)
/projects                      features/projects/ProjectsPage
/projects/:projectId           → last used view for that project (default list)
/projects/:projectId/list      features/list/ListView          rendered inside features/projects/ProjectLayout
/projects/:projectId/board     features/board/BoardView
/projects/:projectId/gantt     features/gantt/GanttView
/timeline                      features/timeline/TimelinePage
/settings/:section             features/settings/SettingsPage  (account | appearance | data; /settings → account)
*                              NotFound
?task=<taskId> on any route    opens the Task Modal for that task (refresh/back/deep-link safe)
```

Page components are **named exports** with the names above; the router lazy-loads them.

Shared UI contracts (provided by the foundation):

- `src/app/uiStore.ts` — `useUIStore`: search overlay, `openNewTask(defaults)`, project dialog,
  milestone dialog, shortcuts help.
- `src/app/taskModalRoute.ts` — `useTaskParam(): string | null`, `useOpenTask(): (taskId) => void`,
  `useCloseTask(): () => void` (manipulate `?task=` preserving other params). Opening pushes a history
  entry and records how many task entries were stacked on the page (`cairnTaskDepth` in history state);
  closing walks back over exactly those, so the first Back afterwards leaves the page. A task URL that
  was not opened from the page (deep link, new tab) is replaced instead of stepped back. An entry
  also records the task it was opened from (`cairnTaskFrom`), so `useCloseTask()({ toParent })` returns
  a subtask to the parent it was opened from (D32). `openTaskFromAnywhere` opens a task from outside
  React (a toast's Open, the sidebar's draft list); the mounted host registers how.
- `src/app/viewPrefs.ts` — per-project last view & Gantt scale (localStorage), recent projects
  (`recordProjectVisit`, `useRecentProjectIds`).
- `src/components/ui/confirm.tsx` — `confirm({ title, description, confirmLabel, destructive }): Promise<boolean>`
  (+ `<ConfirmHost/>` mounted in the shell).
- `src/lib/notify.ts` — toasts. `<Toaster/>` mounted once in the shell.
- Hosts mounted once in the shell: `TaskModalHost` (features/task-modal), `SearchOverlay`
  (features/search), `ProjectDialogHost` (features/projects), `MilestoneDialogHost` (features/milestones),
  `ShortcutsDialog`.
- Shortcuts (`src/app/shortcuts.ts`): ⌘/Ctrl+K search · C new task · `[` toggle sidebar ·
  G then O/M/P/T navigate · `?` shortcuts help · Esc closes overlays. Features may register their own
  (project view 1/2/3, Gantt T = today), via `useViewShortcut`. Shortcuts never fire while typing in
  inputs. Custom Enter and Esc handlers must ignore keys that belong to an IME composition (Chinese
  input): use `isImeKeyEvent` from `src/lib/keyboard.ts`.
- `src/features/projects/viewBar.tsx` — `ProjectLayout` renders the view bar (List/Board/Gantt tabs)
  with a slot; views put their controls there with `<ViewBarActions>…</ViewBarActions>`.
- `src/features/gantt/planner.ts` — `planScheduleChange(change, { source })` (boolean) and
  `planScheduleChangeDetailed` (tells why nothing was written): the ONLY way any view changes task
  dates (Gantt drag, Task Modal, List date fields), so Manual/Auto dependency rules (warn vs. preview +
  atomic apply) behave the same everywhere. The Task Modal's banner replaces the Manual conflict toast
  for `source: 'modal'` (D31). `reviewConflicts(projectId)` and `reviewNewDependency(id)`
  open the same preview. The logic is `createPlanner(env)` (injectable, unit-tested); the exported
  functions use the browser instance. The preview itself is `RescheduleDialog` through
  `rescheduleStore.ts`, mounted once in the shell.

## 8. Design system

Tokens and rationale: `docs/design-research.md` → implemented as CSS custom properties in
`src/styles/tokens.css` (`:root` light, `.dark` dark) and exposed to Tailwind via `@theme inline`.
Use semantic utilities (e.g. `bg-surface`, `text-fg-muted`, `border-subtle`) — never raw hex in components.
Theme: `preferences.theme` (system/light/dark) → `.dark` on `<html>`; an inline script in
`index.html` applies the cached theme before first paint (no flash). The script's hash is listed in
`vercel.json`; `src/test/csp.test.ts` recomputes it, so editing the script means updating the hash.
Gantt day width is 36 / 16 / 5 px for Day / Week / Month: `src/features/gantt/model/scale.ts` is the
source and `--gantt-day-width-*` in `tokens.css` must match.

## 9. Security

- RLS on every table + composite FKs; RPCs are security invoker; anon has no table/function privileges.
- RLS is tested (tests/db) by impersonating two users through `request.jwt.claims` + `set role authenticated`.
- `.env.example` documents variables; `.env*` ignored by git. App code reads `import.meta.env` by name only (reading it whole would inline every `VITE_` variable). `vite build` stops if any `VITE_` variable holds a secret or service-role key, and warns if the Supabase settings cannot sync on a deployed site.
- Supabase Auth email/password; after creating your own account, disable new sign-ups in the dashboard.
- Security headers for the static host in `vercel.json` (CSP allowing only self + hosted Supabase projects, HSTS). `npm run test:prod` runs a real production build behind them.

## 10. Testing & verification

| Command                                                    | What                                                                                                                            |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                        | `tsc -b` (app + node + sim configs)                                                                                             |
| `npm run lint`                                             | oxlint                                                                                                                          |
| `npm test`                                                 | all Vitest projects: `unit` (src/**/\*.test.ts, node), `dom` (src/**/*.test.tsx, jsdom), `db` (tests/db)                        |
| `npm run test:unit` / `npm run test:db`                    | the unit + dom projects only / the db project only (PGlite: migrations, constraints, triggers, RPCs, RLS)                       |
| `npm run test:e2e`                                         | Playwright against `vite --mode e2e` (port 5180) in local data mode                                                             |
| `npm run test:cloud`                                       | Playwright against `vite` in cloud mode (port 5181) and the local Supabase simulator (port 54399)                               |
| `npm run test:prod`                                        | Playwright against production builds behind the real `vercel.json` (CSP, deep links, bundle contents)                           |
| `npx playwright test -c playwright.crossbrowser.config.ts` | opt-in Safari (WebKit) and Firefox run of the acceptance flows; needs `npx playwright install webkit firefox`; never run so far |
| `npm run build`                                            | type check + production build                                                                                                   |

Everything above runs in Chromium (or Node) only. What the simulator proves and does not prove is in
`tests/cloud-sim/README.md`; results, dates and known limitations are in `docs/progress.md`.

Definition of done for any slice: typecheck + lint clean for your files, tests for logic you wrote,
real data flowing through the store (no mock lists, no dead buttons), loading / empty / error states.
