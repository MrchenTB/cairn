import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { isMac } from '@/lib/keyboard'
import { renderUI } from '@/test/render'
import { ThemeProvider } from '../ThemeProvider'
import { useUIStore } from '../uiStore'
import { TopBar } from './TopBar'

afterEach(() => {
  useUIStore.setState({ searchOpen: false, newTask: null })
})

describe('TopBar', () => {
  it('offers one quiet "New task" (icon + tooltip) that defaults to the current project', async () => {
    const { user } = renderUI(
      <ThemeProvider>
        <TopBar />
      </ThemeProvider>,
      { route: '/projects/p1/board' },
    )
    const newTask = screen.getByRole('button', { name: 'New task' })
    expect(newTask).toHaveAttribute('aria-keyshortcuts', 'C')
    expect(newTask).not.toHaveTextContent('New task') // icon-only: the page header owns the label

    await user.click(newTask)
    expect(useUIStore.getState().newTask).toEqual({ projectId: 'p1' })
  })

  it('opens search and reports the platform shortcut and the open state', async () => {
    const { user } = renderUI(
      <ThemeProvider>
        <TopBar />
      </ThemeProvider>,
      { route: '/overview' },
    )
    const search = screen.getByRole('button', { name: /^Search/ })
    expect(search).toHaveAttribute('aria-keyshortcuts', isMac ? 'Meta+K' : 'Control+K')
    expect(search).toHaveAttribute('aria-haspopup', 'dialog')
    expect(search).toHaveAttribute('aria-expanded', 'false')

    await user.click(search)
    expect(useUIStore.getState().searchOpen).toBe(true)
    expect(search).toHaveAttribute('aria-expanded', 'true')
  })
})
