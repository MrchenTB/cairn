import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter } from 'react-router'
import { RouterProvider } from 'react-router/dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfirmHost } from '@/components/ui/confirm'
import { TooltipProvider } from '@/components/ui/tooltip'
import { getBrowserTimeZone } from '@/domain/dates'
import {
  getWorkspaceActions,
  SYNC_ERROR_TOAST_ID,
  useAuthStore,
  useWorkspaceStore,
} from '@/data/store'
import type { BackupFile } from '@/domain/types'
import { taskDrafts } from '@/features/task-modal/autosave/taskDrafts'
import { notify } from '@/lib/notify'
import { APP_VERSION } from './about'
import { SettingsPage } from './SettingsPage'

function must<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function renderSettings(section = 'account') {
  const router = createMemoryRouter(
    [
      {
        path: '/settings/:section',
        element: (
          <TooltipProvider delayDuration={0}>
            <SettingsPage />
            <ConfirmHost />
          </TooltipProvider>
        ),
      },
    ],
    { initialEntries: [`/settings/${section}`] },
  )
  const user = userEvent.setup()
  render(<RouterProvider router={router} />)
  return { router, user }
}

const actions = () => useWorkspaceStore.getState().actions
const preferences = () => useWorkspaceStore.getState().preferences

/** A project with two tasks, saved through the store. */
async function seedWorkspace() {
  const a = getWorkspaceActions()
  const project = must(await a.createProject({ name: 'Research' }))
  must(await a.createTask({ projectId: project.id, title: 'Interview users' }))
  must(await a.createTask({ projectId: project.id, title: 'Write brief' }))
  must(await a.load())
  return project
}

/** jsdom has neither Blob.text() nor URL.createObjectURL. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

function captureDownloads() {
  const blobs: Blob[] = []
  const anchors: HTMLAnchorElement[] = []
  Object.assign(URL, {
    createObjectURL: vi.fn((blob: Blob) => {
      blobs.push(blob)
      return `blob:cairn/${blobs.length}`
    }),
    revokeObjectURL: vi.fn(),
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    anchors.push(this)
  })
  return { blobs, anchors }
}

const initialAuth = useAuthStore.getState()

beforeEach(async () => {
  localStorage.clear()
  window.__cairnTest?.failNextWrites(0)
  window.__cairnTest?.setLatency(0)
  actions().reset()
  must(await actions().load())
})

afterEach(() => {
  vi.restoreAllMocks()
  useAuthStore.setState({
    mode: initialAuth.mode,
    status: initialAuth.status,
    user: initialAuth.user,
  })
  useWorkspaceStore.setState({ mode: 'local' })
})

describe('SettingsPage: navigation', () => {
  it('lists the sections, marks the current one and switches between them', async () => {
    const { user } = renderSettings('data')
    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    expect(within(nav).getByRole('link', { name: 'Data' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('heading', { name: 'Sync status' })).toBeInTheDocument()

    await user.click(within(nav).getByRole('link', { name: 'Appearance' }))
    expect(await screen.findByRole('heading', { name: 'Appearance', level: 2 })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Sync status' })).not.toBeInTheDocument()
  })

  it('falls back to Account for an unknown section', () => {
    renderSettings('nope')
    expect(screen.getByRole('heading', { name: 'Account', level: 2 })).toBeInTheDocument()
  })
})

describe('SettingsPage: Account', () => {
  it('explains local mode, has nothing to sign out of and shows the version', () => {
    renderSettings('account')
    expect(screen.getByText('Local mode — data stays in this browser')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
    expect(screen.getByText(`Version ${APP_VERSION}`)).toBeInTheDocument()
  })

  describe('with a cloud account', () => {
    beforeEach(() => {
      useWorkspaceStore.setState({ mode: 'supabase' })
      useAuthStore.setState({
        mode: 'supabase',
        status: 'signed_in',
        user: { id: 'user-1', email: 'ada@example.com' },
      })
    })

    it('shows the email and signs out only after confirming', async () => {
      const signOut = vi
        .spyOn(useAuthStore.getState().actions, 'signOut')
        .mockResolvedValue({ ok: true, value: undefined })
      const { user } = renderSettings('account')
      expect(screen.getByText('ada@example.com')).toBeInTheDocument()

      await user.click(screen.getByRole('button', { name: 'Sign out' }))
      const dialog = await screen.findByRole('alertdialog', { name: 'Sign out of Cairn?' })
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      expect(signOut).not.toHaveBeenCalled()

      await user.click(screen.getByRole('button', { name: 'Sign out' }))
      const again = await screen.findByRole('alertdialog')
      await user.click(within(again).getByRole('button', { name: 'Sign out' }))
      await waitFor(() => expect(signOut).toHaveBeenCalledTimes(1))
    })

    it('keeps the failure visible when signing out fails', async () => {
      vi.spyOn(useAuthStore.getState().actions, 'signOut').mockResolvedValue({
        ok: false,
        error: { kind: 'network', message: "Couldn't reach the server." },
      })
      const { user } = renderSettings('account')
      await user.click(screen.getByRole('button', { name: 'Sign out' }))
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Sign out' }),
      )
      expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't reach the server.")
    })
  })
})

// The time zone menu renders hundreds of options under user-event: past the default 5 s on a loaded
// machine (the whole suite in parallel), though it takes about 2 s alone.
describe('SettingsPage: Appearance', { timeout: 20_000 }, () => {
  it('saves a theme change through updatePreferences', async () => {
    const update = vi.spyOn(actions(), 'updatePreferences')
    const { user } = renderSettings('appearance')
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()

    await user.click(screen.getByRole('radio', { name: 'Dark' }))

    expect(update).toHaveBeenCalledWith({ theme: 'dark' })
    await waitFor(() => expect(preferences().theme).toBe('dark'))
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeChecked()
  })

  it('saves the first day of the week', async () => {
    const update = vi.spyOn(actions(), 'updatePreferences')
    const { user } = renderSettings('appearance')
    const start = preferences().weekStartsOn
    const target = start === 1 ? 'Sunday' : 'Monday'

    await user.click(screen.getByRole('radio', { name: target }))

    expect(update).toHaveBeenCalledWith({ weekStartsOn: start === 1 ? 0 : 1 })
    await waitFor(() => expect(preferences().weekStartsOn).toBe(start === 1 ? 0 : 1))
  })

  it('searches the time zones, saves the pick and can go back to the browser zone', async () => {
    const update = vi.spyOn(actions(), 'updatePreferences')
    const browser = getBrowserTimeZone()
    const other = browser === 'Asia/Tokyo' ? 'Europe/Berlin' : 'Asia/Tokyo'
    const otherName = other.replace('_', ' ')
    const { user } = renderSettings('appearance')

    const useBrowser = screen.getByRole('button', { name: 'Use browser time zone' })
    expect(preferences().timezone).toBe(browser)
    expect(useBrowser).toBeDisabled() // already the browser's zone

    await user.click(screen.getByRole('combobox', { name: /^Time zone:/ }))
    await user.type(screen.getByPlaceholderText('Search time zones…'), other.split('/')[1])
    const option = await screen.findByRole('option', { name: new RegExp(otherName) })
    expect(option).toHaveTextContent(/UTC[+-]\d{2}:\d{2}/)
    await user.click(option)

    expect(update).toHaveBeenCalledWith({ timezone: other })
    await waitFor(() => expect(preferences().timezone).toBe(other))
    expect(
      screen.getByRole('combobox', { name: new RegExp(`^Time zone: ${otherName}`) }),
    ).toBeVisible()
    expect(screen.getByText(new RegExp(`in ${other}`))).toBeInTheDocument() // today's date preview

    expect(useBrowser).toBeEnabled()
    await user.click(useBrowser)
    expect(update).toHaveBeenLastCalledWith({ timezone: browser })
    await waitFor(() => expect(preferences().timezone).toBe(browser))
  })

  it('tells the user when no time zone matches the search', async () => {
    const { user } = renderSettings('appearance')
    await user.click(screen.getByRole('combobox', { name: /^Time zone:/ }))
    await user.type(screen.getByPlaceholderText('Search time zones…'), 'atlantis')
    expect(await screen.findByText('No time zone matches "atlantis".')).toBeInTheDocument()
  })

  it('shows a rejected value next to the field', async () => {
    vi.spyOn(actions(), 'updatePreferences').mockResolvedValue({
      ok: false,
      error: { kind: 'validation', message: 'Choose a valid time zone.' },
    })
    const { user } = renderSettings('appearance')
    await user.click(screen.getByRole('combobox', { name: /^Time zone:/ }))
    await user.type(screen.getByPlaceholderText('Search time zones…'), 'Paris')
    await user.click(await screen.findByRole('option', { name: /Europe\/Paris/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose a valid time zone.')
  })
})

describe('SettingsPage: Data', () => {
  it('shows the real sync state of local mode', () => {
    renderSettings('data')
    expect(screen.getByText('Stored in this browser only')).toBeInTheDocument()
    expect(screen.getByText('Local only — this browser')).toBeInTheDocument()
    expect(screen.queryByText(/Cloud sync/)).not.toBeInTheDocument() // never presented as cloud sync
    expect(screen.getByText('Online')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled()
    expect(screen.getByText(/Local mode keeps everything in this browser only/)).toBeInTheDocument()
  })

  it('"Sync now" re-reads the workspace silently and confirms it', async () => {
    useWorkspaceStore.setState({ mode: 'supabase' })
    const refresh = vi.spyOn(actions(), 'refresh')
    const success = vi.spyOn(notify, 'success')
    const { user } = renderSettings('data')
    expect(screen.getByText('Cloud sync (Supabase)')).toBeInTheDocument()
    expect(screen.getByText(/Supabase's Free plan has no automatic backups/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Sync now' }))

    // Not the store's loading state: that would replace the whole page with a skeleton.
    expect(refresh).toHaveBeenCalledWith({ silent: true, reportFailure: true })
    await waitFor(() => expect(success).toHaveBeenCalledWith('Synced with the cloud'))
  })

  it('"Sync now" keeps the page and the keyboard focus while it runs', async () => {
    window.__cairnTest?.setLatency(150)
    const { user } = renderSettings('data')
    const button = screen.getByRole('button', { name: 'Sync now' })
    button.focus()

    await user.keyboard('{Enter}')

    expect(button).toHaveAttribute('aria-busy', 'true')
    expect(button).toBeEnabled() // a disabled button would drop focus to the page
    expect(button).toHaveFocus()
    expect(useWorkspaceStore.getState().status).toBe('ready') // no loading state: no skeleton
    // A second press while it runs does not start a second refresh.
    await user.keyboard('{Enter}')
    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'))
    expect(button).toHaveFocus()
  })

  it('says so on the card when "Sync now" cannot reach the data', async () => {
    useWorkspaceStore.setState({ mode: 'supabase' })
    vi.spyOn(actions(), 'refresh').mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Network error — check your connection.' },
    })
    const success = vi.spyOn(notify, 'success')
    const error = vi.spyOn(notify, 'error')
    const { user } = renderSettings('data')

    await user.click(screen.getByRole('button', { name: 'Sync now' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Couldn't refresh · Network error — check your connection.",
    )
    expect(error).toHaveBeenCalledWith("Couldn't refresh", {
      description: 'Network error — check your connection.',
    })
    expect(success).not.toHaveBeenCalled()
    // The same text is the "Last error" of the card until a load succeeds.
    const row = screen.getByText('Last error').closest('div') as HTMLElement
    expect(row).toHaveTextContent('Network error — check your connection.')
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeEnabled() // try again
  })

  it('lists the last error and retries the failed save', async () => {
    const retry = vi
      .spyOn(actions(), 'retryLastFailed')
      .mockResolvedValue({ ok: true, value: undefined })
    useWorkspaceStore.setState((state) => ({
      sync: {
        ...state.sync,
        lastError: { kind: 'network', message: 'The network request failed.' },
        canRetry: true,
      },
    }))
    const { user } = renderSettings('data')

    expect(screen.getByText("Couldn't save your last change")).toBeInTheDocument()
    expect(screen.getAllByText(/The network request failed\./).length).toBeGreaterThan(0)
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledTimes(1)
  })

  it('counts pending writes and waits for them before syncing', () => {
    useWorkspaceStore.setState((state) => ({ sync: { ...state.sync, pending: 2 } }))
    renderSettings('data')
    expect(screen.getByText('2 waiting to be saved')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sync now' })).toBeDisabled()
  })
})

describe('SettingsPage: exports', () => {
  it('downloads a JSON backup of the workspace and remembers when', async () => {
    await seedWorkspace()
    const { anchors, blobs } = captureDownloads()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderSettings('data')
    expect(screen.getByText(/haven't exported a backup from this browser yet/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))

    expect(anchors).toHaveLength(1)
    expect(anchors[0].download).toMatch(/^cairn-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const file = JSON.parse(await blobText(blobs[0])) as BackupFile
    expect(file.app).toBe('cairn')
    expect(file.data.projects.map((p) => p.name)).toEqual(['Research'])
    expect(file.data.tasks).toHaveLength(2)
    expect(success).toHaveBeenCalledWith(
      'Backup exported',
      expect.objectContaining({ description: expect.stringContaining('1 project and 2 tasks') }),
    )
    expect(screen.getByText(/Last exported just now from this browser/)).toBeInTheDocument()
  })

  it('exports without asking anything when everything is saved', async () => {
    await seedWorkspace()
    const { anchors } = captureDownloads()
    const { user } = renderSettings('data')

    await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))

    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(anchors).toHaveLength(1)
  })

  it('exports what is saved, not the screen', async () => {
    await seedWorkspace()
    const { blobs } = captureDownloads()
    const exportSaved = vi.spyOn(actions(), 'exportSavedBackup')
    const exportScreen = vi.spyOn(actions(), 'exportBackup')
    const { user } = renderSettings('data')

    await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))

    await waitFor(() => expect(blobs).toHaveLength(1))
    expect(exportSaved).toHaveBeenCalledTimes(1)
    expect(exportScreen).not.toHaveBeenCalled()
  })

  describe('with a change that could not be saved', () => {
    async function failOneWrite() {
      const project = await seedWorkspace()
      const task = Object.values(useWorkspaceStore.getState().data.tasks)[0]
      window.__cairnTest?.failNextWrites(1)
      const result = await actions().updateTask(task.id, { title: 'Not saved' })
      expect(result.ok).toBe(false)
      expect(useWorkspaceStore.getState().sync.canRetry).toBe(true)
      return project
    }

    it('still asks after a later, unrelated change was saved (the failure is not forgotten)', async () => {
      await failOneWrite()
      const other = Object.values(useWorkspaceStore.getState().data.tasks)[1]
      expect((await actions().updateTask(other.id, { priority: 'high' })).ok).toBe(true)
      const { anchors } = captureDownloads()
      const { user } = renderSettings('data')

      await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))
      const dialog = await screen.findByRole('alertdialog', { name: "Some changes aren't saved" })
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      expect(anchors).toHaveLength(0)
    })

    it('asks first and exports nothing when cancelled', async () => {
      await failOneWrite()
      const { anchors } = captureDownloads()
      const exportSaved = vi.spyOn(actions(), 'exportSavedBackup')
      const { user } = renderSettings('data')

      await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))
      const dialog = await screen.findByRole('alertdialog', { name: "Some changes aren't saved" })
      expect(dialog).toHaveTextContent(/without the changes that couldn't be saved/)
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

      await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
      expect(exportSaved).toHaveBeenCalledTimes(1) // read first, then asked: nothing handed out
      expect(anchors).toHaveLength(0)
      expect(
        screen.getByText(/haven't exported a backup from this browser yet/),
      ).toBeInTheDocument()
    })

    it('exports what is saved after "Export anyway"', async () => {
      await failOneWrite()
      const { anchors, blobs } = captureDownloads()
      const { user } = renderSettings('data')

      await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))
      const dialog = await screen.findByRole('alertdialog', { name: "Some changes aren't saved" })
      await user.click(within(dialog).getByRole('button', { name: 'Export anyway' }))

      await waitFor(() => expect(anchors).toHaveLength(1))
      const file = JSON.parse(await blobText(blobs[0])) as BackupFile
      expect(file.data.tasks.map((t) => t.title)).not.toContain('Not saved')
      expect(file.data.tasks).toHaveLength(2)
    })
  })

  it('says when the saved data was read, and that a change made during the read is not in the file', async () => {
    await seedWorkspace()
    const task = Object.values(useWorkspaceStore.getState().data.tasks)[0]
    const { blobs } = captureDownloads()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderSettings('data')
    window.__cairnTest?.setLatency(150) // the read takes a while…
    await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))
    // …and the user changes something meanwhile (another tab, the search palette)
    const change = actions().updateTask(task.id, { title: 'Changed during the export' })

    await waitFor(() => expect(blobs).toHaveLength(1))
    expect((await change).ok).toBe(true)
    window.__cairnTest?.setLatency(0)
    const file = JSON.parse(await blobText(blobs[0])) as BackupFile
    expect(file.data.tasks.map((t) => t.title)).not.toContain('Changed during the export')
    expect(useWorkspaceStore.getState().data.tasks[task.id].title).toBe('Changed during the export')
    expect(success).toHaveBeenCalledWith('Backup exported', {
      description: expect.stringMatching(
        /saved data as of Today, \d{1,2}:\d{2} [AP]M\. Changes made after that aren’t included\.$/,
      ),
    })
  })

  it('does not mention later changes when there were none', async () => {
    await seedWorkspace()
    captureDownloads()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderSettings('data')
    await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))
    await waitFor(() => expect(success).toHaveBeenCalled())
    const { description } = success.mock.calls.at(-1)?.[1] as { description: string }
    expect(description).toMatch(/saved data as of Today, \d{1,2}:\d{2} [AP]M\.$/)
    expect(description).not.toMatch(/Changes made after/)
  })

  it('asks first when a write still in flight fails while the export waits for it', async () => {
    await seedWorkspace()
    const task = Object.values(useWorkspaceStore.getState().data.tasks)[0]
    const { anchors } = captureDownloads()
    const { user } = renderSettings('data')
    window.__cairnTest?.setLatency(150)
    window.__cairnTest?.failNextWrites(1)
    const saving = actions().updateTask(task.id, { title: 'Fails while exporting' })
    expect(useWorkspaceStore.getState().sync.canRetry).toBe(false) // nothing failed yet

    await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))
    const dialog = await screen.findByRole('alertdialog', { name: "Some changes aren't saved" })
    expect((await saving).ok).toBe(false)
    expect(anchors).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument())
    expect(anchors).toHaveLength(0)
    window.__cairnTest?.setLatency(0)
  })

  it('asks first when task text is not saved yet', async () => {
    await seedWorkspace()
    const { anchors } = captureDownloads()
    vi.spyOn(taskDrafts, 'getOutstanding').mockReturnValue([
      {
        key: 't|title',
        taskId: 't',
        field: 'title',
        taskTitle: 'Write brief',
        taskExists: true,
        phase: 'failed',
        text: 'Unsaved words',
        error: 'The network request failed.',
      },
    ])
    const { user } = renderSettings('data')

    await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))
    const dialog = await screen.findByRole('alertdialog', { name: "Some changes aren't saved" })
    expect(anchors).toHaveLength(0)
    await user.click(within(dialog).getByRole('button', { name: 'Export anyway' }))

    await waitFor(() => expect(anchors).toHaveLength(1))
  })

  it('shows why and downloads nothing when the saved data cannot be read', async () => {
    await seedWorkspace()
    const { anchors } = captureDownloads()
    vi.spyOn(actions(), 'exportSavedBackup').mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'The network request failed.' },
    })
    const success = vi.spyOn(notify, 'success')
    const error = vi.spyOn(notify, 'error')
    const { user } = renderSettings('data')

    await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))

    await waitFor(() =>
      expect(error).toHaveBeenCalledWith("Couldn't export the backup", {
        description: 'The network request failed.',
      }),
    )
    expect(anchors).toHaveLength(0)
    expect(success).not.toHaveBeenCalled()
    expect(screen.getByText(/haven't exported a backup from this browser yet/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export JSON backup' })).not.toHaveAttribute(
      'aria-busy',
    )
  })

  it('ignores a second click while the export is under way', async () => {
    await seedWorkspace()
    captureDownloads()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const original = actions().exportSavedBackup
    const exportSaved = vi.spyOn(actions(), 'exportSavedBackup').mockImplementation(async () => {
      await gate
      return original()
    })
    const { user } = renderSettings('data')
    const button = screen.getByRole('button', { name: 'Export JSON backup' })

    await user.click(button)
    expect(button).toHaveAttribute('aria-busy', 'true')
    await user.click(button)
    release()

    await waitFor(() => expect(button).not.toHaveAttribute('aria-busy'))
    expect(exportSaved).toHaveBeenCalledTimes(1)
  })

  it('downloads the tasks as CSV', async () => {
    await seedWorkspace()
    const { anchors, blobs } = captureDownloads()
    const { user } = renderSettings('data')

    await user.click(screen.getByRole('button', { name: 'Export tasks CSV' }))

    expect(anchors[0].download).toMatch(/^cairn-tasks-\d{4}-\d{2}-\d{2}\.csv$/)
    const csv = await blobText(blobs[0])
    expect(csv).toContain('Interview users')
    expect(csv).toContain('Write brief')
  })

  it('says an empty backup is empty instead of "nothing"', async () => {
    captureDownloads()
    const success = vi.spyOn(notify, 'success')
    const { user } = renderSettings('data')

    await user.click(screen.getByRole('button', { name: 'Export JSON backup' }))

    expect(success).toHaveBeenCalledWith('Backup exported', {
      description: expect.stringMatching(
        /^cairn-backup-\d{4}-\d{2}-\d{2}\.json · no projects or tasks yet · saved data as of Today, \d{1,2}:\d{2} [AP]M\.$/,
      ),
    })
  })

  it('has no tasks to export in an empty workspace', () => {
    renderSettings('data')
    expect(screen.getByRole('button', { name: 'Export tasks CSV' })).toBeDisabled()
    expect(screen.getByText('No tasks to export yet.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Export JSON backup' })).toBeEnabled()
  })
})

describe('SettingsPage: import', () => {
  const upload = (user: ReturnType<typeof userEvent.setup>, name: string, body: string) =>
    user.upload(
      screen.getByLabelText('Backup file'),
      new File([body], name, { type: 'application/json' }),
    )

  it('explains a file that is not JSON', async () => {
    const { user } = renderSettings('data')
    await upload(user, 'notes.json', '{ definitely not json')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn\'t import "notes.json"')
    expect(alert).toHaveTextContent("isn't valid JSON")
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists what is wrong with a file that is not a valid backup and imports nothing', async () => {
    const { user } = renderSettings('data')
    const broken = {
      app: 'cairn',
      formatVersion: 1,
      exportedAt: '2026-11-02T12:00:00.000Z',
      preferences: null,
      data: {
        projects: [],
        phases: [],
        tasks: [
          {
            id: '11111111-1111-4111-8111-111111111111',
            projectId: '22222222-2222-4222-8222-222222222222',
            phaseId: null,
            parentTaskId: null,
            title: 'Orphan',
            description: null,
            status: 'todo',
            priority: 'none',
            startDate: null,
            dueDate: null,
            sortOrder: 'a0',
            completedAt: null,
            createdAt: '2026-11-01T00:00:00.000Z',
            updatedAt: '2026-11-01T00:00:00.000Z',
          },
        ],
        milestones: [],
        dependencies: [],
      },
    }
    await upload(user, 'broken.json', JSON.stringify(broken))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('Couldn\'t import "broken.json"')
    expect(within(alert).getAllByRole('listitem')[0]).toHaveTextContent(/Orphan.*isn't in the file/)
    expect(Object.keys(useWorkspaceStore.getState().data.tasks)).toHaveLength(0)

    await user.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('previews counts and date, then adds the file as new copies', async () => {
    await seedWorkspace()
    const backup = actions().exportBackup()
    const importBackup = vi.spyOn(actions(), 'importBackup')
    const success = vi.spyOn(notify, 'success')
    const { user } = renderSettings('data')

    await upload(user, 'my-backup.json', JSON.stringify(backup))

    const dialog = await screen.findByRole('dialog', { name: 'Import backup' })
    expect(dialog).toHaveTextContent('my-backup.json')
    expect(dialog).toHaveTextContent(/Exported \w{3} \d{1,2}, \d{4}/)
    const row = (label: string) => within(dialog).getByText(label).closest('div') as HTMLElement
    expect(row('Projects')).toHaveTextContent('1')
    expect(row('Tasks')).toHaveTextContent('2')
    expect(row('Milestones')).toHaveTextContent('0')
    expect(dialog).toHaveTextContent(/added as new copies/)
    expect(dialog).toHaveTextContent(/Nothing that exists today is changed, overwritten or deleted/)

    await user.click(within(dialog).getByRole('button', { name: 'Import as new copies' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importBackup).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith('Backup imported', {
      description: 'Added 1 project and 2 tasks as new copies.',
    })
    const { data } = useWorkspaceStore.getState()
    expect(Object.values(data.projects).map((p) => p.name)).toEqual(['Research', 'Research'])
    expect(Object.keys(data.tasks)).toHaveLength(4)
    // New copies: the original rows are untouched and no id was reused.
    expect(new Set(Object.keys(data.projects)).size).toBe(2)
  })

  it('imports nothing when the preview is cancelled', async () => {
    await seedWorkspace()
    const backup = actions().exportBackup()
    const importBackup = vi.spyOn(actions(), 'importBackup')
    const { user } = renderSettings('data')

    await upload(user, 'my-backup.json', JSON.stringify(backup))
    const dialog = await screen.findByRole('dialog', { name: 'Import backup' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importBackup).not.toHaveBeenCalled()
    expect(Object.keys(useWorkspaceStore.getState().data.projects)).toHaveLength(1)
  })

  it('keeps the dialog open and shows the reason when the import fails', async () => {
    await seedWorkspace()
    const backup = actions().exportBackup()
    vi.spyOn(actions(), 'importBackup').mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: "Couldn't reach the server. Nothing was imported." },
    })
    const success = vi.spyOn(notify, 'success')
    const { user } = renderSettings('data')

    await upload(user, 'my-backup.json', JSON.stringify(backup))
    const dialog = await screen.findByRole('dialog', { name: 'Import backup' })
    await user.click(within(dialog).getByRole('button', { name: 'Import as new copies' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Nothing was imported.')
    expect(screen.getByRole('dialog', { name: 'Import backup' })).toBeInTheDocument()
    expect(success).not.toHaveBeenCalled()
  })

  it('offers "Try again" that re-sends the same copy instead of importing a second one', async () => {
    await seedWorkspace()
    const backup = actions().exportBackup()
    const importBackup = vi.spyOn(actions(), 'importBackup').mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Network error — check your connection.' },
    })
    const retry = vi
      .spyOn(actions(), 'retryLastFailed')
      .mockResolvedValue({ ok: true, value: undefined })
    const dismiss = vi.spyOn(notify, 'dismiss')
    const success = vi.spyOn(notify, 'success')
    const { user } = renderSettings('data')

    await upload(user, 'my-backup.json', JSON.stringify(backup))
    const dialog = await screen.findByRole('dialog', { name: 'Import backup' })
    await user.click(within(dialog).getByRole('button', { name: 'Import as new copies' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Network error')
    expect(dialog).toHaveTextContent(/nothing is added twice/)
    // The dialog owns the retry: the store's toast (whose Retry would import the file again next
    // to this button) is taken away.
    expect(dismiss).toHaveBeenCalledWith(SYNC_ERROR_TOAST_ID)

    await user.click(within(dialog).getByRole('button', { name: 'Try again' }))

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(importBackup).toHaveBeenCalledTimes(1) // never a second, independent import
    expect(retry).toHaveBeenCalledTimes(1)
    expect(success).toHaveBeenCalledWith('Backup imported', {
      description: 'Added 1 project and 2 tasks as new copies.',
    })
  })

  it('keeps offering a fresh import when the store cannot retry the failure', async () => {
    await seedWorkspace()
    const backup = actions().exportBackup()
    const importBackup = vi.spyOn(actions(), 'importBackup').mockResolvedValue({
      ok: false,
      error: { kind: 'permission', message: "You don't have permission to do that." },
    })
    const retry = vi.spyOn(actions(), 'retryLastFailed')
    const { user } = renderSettings('data')

    await upload(user, 'my-backup.json', JSON.stringify(backup))
    const dialog = await screen.findByRole('dialog', { name: 'Import backup' })
    await user.click(within(dialog).getByRole('button', { name: 'Import as new copies' }))

    expect(await within(dialog).findByRole('alert')).toHaveTextContent("don't have permission")
    expect(within(dialog).queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument()
    await user.click(within(dialog).getByRole('button', { name: 'Import as new copies' }))
    await waitFor(() => expect(importBackup).toHaveBeenCalledTimes(2))
    expect(retry).not.toHaveBeenCalled()
  })

  it('stays on "Try again" when the retry fails as well', async () => {
    await seedWorkspace()
    const backup = actions().exportBackup()
    vi.spyOn(actions(), 'importBackup').mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Network error — check your connection.' },
    })
    const retry = vi.spyOn(actions(), 'retryLastFailed').mockResolvedValue({
      ok: false,
      error: { kind: 'network', message: 'Still offline.' },
    })
    const success = vi.spyOn(notify, 'success')
    const { user } = renderSettings('data')

    await upload(user, 'my-backup.json', JSON.stringify(backup))
    const dialog = await screen.findByRole('dialog', { name: 'Import backup' })
    await user.click(within(dialog).getByRole('button', { name: 'Import as new copies' }))
    await user.click(await within(dialog).findByRole('button', { name: 'Try again' }))

    expect(await within(dialog).findByText('Still offline.')).toBeInTheDocument()
    expect(within(dialog).getByRole('button', { name: 'Try again' })).toBeEnabled()
    expect(retry).toHaveBeenCalledTimes(1)
    expect(success).not.toHaveBeenCalled()
  })

  it('gives keyboard focus back to the Import button when the dialog closes', async () => {
    await seedWorkspace()
    const backup = actions().exportBackup()
    const { user } = renderSettings('data')
    const button = screen.getByRole('button', { name: 'Import backup…' })
    button.focus()

    await upload(user, 'my-backup.json', JSON.stringify(backup))
    const dialog = await screen.findByRole('dialog', { name: 'Import backup' })
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(button).toHaveFocus())

    await upload(user, 'my-backup.json', JSON.stringify(backup))
    const again = await screen.findByRole('dialog', { name: 'Import backup' })
    await user.click(within(again).getByRole('button', { name: 'Import as new copies' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await waitFor(() => expect(button).toHaveFocus())
  })

  it('refuses to import a backup that is empty', async () => {
    const { user } = renderSettings('data')
    const empty = actions().exportBackup() // nothing created in this workspace
    await upload(user, 'empty.json', JSON.stringify(empty))

    const dialog = await screen.findByRole('dialog', { name: 'Import backup' })
    expect(dialog).toHaveTextContent('nothing to import')
    expect(within(dialog).getByRole('button', { name: 'Import as new copies' })).toBeDisabled()
  })
})
