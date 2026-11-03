import { fireEvent, render, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formatHotkey,
  hotkeyLabel,
  isEditableTarget,
  matchesChord,
  parseHotkey,
  registerHotkey,
  resetHotkeysForTests,
  useHotkeys,
} from './keyboard'

// jsdom is not macOS, so `mod` = Ctrl.
const press = (
  key: string,
  init: KeyboardEventInit = {},
  target: Element | Document | Window = document.body,
) => fireEvent.keyDown(target, { key, ...init })

const keyLike = (key: string, code: string, init: Partial<KeyboardEventInit> = {}) => ({
  key,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...init,
})

afterEach(() => {
  resetHotkeysForTests()
})

describe('parseHotkey / matchesChord', () => {
  it('parses chords and sequences', () => {
    expect(parseHotkey('mod+k')).toEqual([
      { key: 'k', mod: true, ctrl: false, meta: false, alt: false, shift: false },
    ])
    expect(parseHotkey('g o').map((chord) => chord.key)).toEqual(['g', 'o'])
    expect(parseHotkey('?')[0].shift).toBeNull()
  })

  it('requires exact modifiers but ignores Shift for symbols', () => {
    const [modK] = parseHotkey('mod+k')
    expect(matchesChord(keyLike('k', 'KeyK', { ctrlKey: true }), modK)).toBe(true)
    expect(matchesChord(keyLike('k', 'KeyK'), modK)).toBe(false)
    const [question] = parseHotkey('?')
    expect(matchesChord(keyLike('?', 'Slash', { shiftKey: true }), question)).toBe(true)
    const [c] = parseHotkey('c')
    expect(matchesChord(keyLike('c', 'KeyC', { ctrlKey: true }), c)).toBe(false)
  })

  it('falls back to the physical key for letters on non-Latin layouts', () => {
    const [c] = parseHotkey('c')
    expect(matchesChord(keyLike('с', 'KeyC'), c)).toBe(true)
  })
})

describe('dispatcher', () => {
  it('fires single keys and ignores typing in fields', () => {
    const handler = vi.fn()
    renderHook(() => useHotkeys('c', handler))
    press('c')
    expect(handler).toHaveBeenCalledTimes(1)

    const { getByRole } = render(<input aria-label="Title" />)
    press('c', {}, getByRole('textbox'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('allows opted-in bindings inside fields (⌘K)', () => {
    const handler = vi.fn()
    renderHook(() => useHotkeys('mod+k', handler, { allowInInput: true }))
    const { getByRole } = render(<textarea aria-label="Notes" />)
    press('k', { ctrlKey: true }, getByRole('textbox'))
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('handles G-then-X sequences', () => {
    const overview = vi.fn()
    const timeline = vi.fn()
    renderHook(() => {
      useHotkeys('g o', overview)
      useHotkeys('g t', timeline)
    })
    press('g')
    press('o')
    expect(overview).toHaveBeenCalledTimes(1)
    press('g')
    press('x')
    press('t')
    expect(timeline).not.toHaveBeenCalled()
    press('g')
    press('t')
    expect(timeline).toHaveBeenCalledTimes(1)
  })

  it('does not fire while an overlay is open unless allowed', () => {
    const plain = vi.fn()
    const allowed = vi.fn()
    renderHook(() => {
      useHotkeys('c', plain)
      useHotkeys('mod+k', allowed, { allowInModal: true })
    })
    render(<div role="dialog" data-state="open" />)
    press('c')
    press('k', { ctrlKey: true })
    expect(plain).not.toHaveBeenCalled()
    expect(allowed).toHaveBeenCalledTimes(1)
  })

  it('ignores IME composition and key repeat', () => {
    const handler = vi.fn()
    renderHook(() => useHotkeys('c', handler))
    press('c', { isComposing: true })
    press('Process', { keyCode: 229 })
    press('c', { repeat: true })
    expect(handler).not.toHaveBeenCalled()
  })

  it('lets the most recent registration win and cleans up on unmount', () => {
    const globalHandler = vi.fn()
    const viewHandler = vi.fn()
    renderHook(() => useHotkeys('t', globalHandler))
    const { unmount } = renderHook(() => useHotkeys('t', viewHandler))
    press('t')
    expect(viewHandler).toHaveBeenCalledTimes(1)
    expect(globalHandler).not.toHaveBeenCalled()
    unmount()
    press('t')
    expect(globalHandler).toHaveBeenCalledTimes(1)
  })

  it('prevents the browser default only when a binding fires', () => {
    const unregister = registerHotkey('mod+k', () => {})
    const handled = new KeyboardEvent('keydown', {
      key: 'k',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    document.body.dispatchEvent(handled)
    expect(handled.defaultPrevented).toBe(true)
    const unrelated = new KeyboardEvent('keydown', {
      key: 'j',
      ctrlKey: true,
      cancelable: true,
      bubbles: true,
    })
    document.body.dispatchEvent(unrelated)
    expect(unrelated.defaultPrevented).toBe(false)
    unregister()
  })
})

describe('helpers', () => {
  it('detects editable targets', () => {
    const { getByLabelText } = render(
      <>
        <input aria-label="text" />
        <input aria-label="check" type="checkbox" />
      </>,
    )
    expect(isEditableTarget(getByLabelText('text'))).toBe(true)
    expect(isEditableTarget(getByLabelText('check'))).toBe(false)
    expect(isEditableTarget(document.body)).toBe(false)
  })

  it('formats bindings for display (non-mac)', () => {
    expect(formatHotkey('mod+k')).toEqual([['Ctrl', 'K']])
    expect(formatHotkey('g o')).toEqual([['G'], ['O']])
    expect(hotkeyLabel('g o')).toBe('G then O')
    expect(hotkeyLabel('shift+enter')).toBe('Shift+Enter')
  })
})
