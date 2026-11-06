import { afterEach, describe, expect, it } from 'vitest'
import {
  FOCUS_KEY_ATTRIBUTE,
  getFocusReturnTarget,
  isFocusOwnedElsewhere,
  restoreFocus,
} from './focus'

function button(label: string, parent: HTMLElement = document.body): HTMLButtonElement {
  const element = document.createElement('button')
  element.textContent = label
  parent.append(element)
  return element
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('getFocusReturnTarget', () => {
  it('returns the focused element, or null when only <body> has focus', () => {
    expect(getFocusReturnTarget()).toBeNull()
    const save = button('Save')
    save.focus()
    expect(getFocusReturnTarget()).toBe(save)
  })

  it('uses the menu trigger when focus is on an item of a menu that is closing', () => {
    const trigger = button('More')
    trigger.id = 'more-trigger'
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    menu.setAttribute('aria-labelledby', 'more-trigger')
    document.body.append(menu)
    const item = button('Delete…', menu)
    item.focus()
    expect(getFocusReturnTarget()).toBe(trigger)
  })
})

describe('restoreFocus', () => {
  it('focuses the target when focus fell back to <body>', () => {
    const target = button('Opener')
    expect(restoreFocus(target)).toBe(true)
    expect(target).toHaveFocus()
  })

  it('never steals focus that something else took, nor focuses detached elements', () => {
    const target = button('Opener')
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    expect(restoreFocus(target)).toBe(false)
    expect(field).toHaveFocus()

    field.blur()
    target.remove()
    expect(restoreFocus(target)).toBe(false)
    expect(restoreFocus(null)).toBe(false)
  })

  it('finds the element that replaced a detached target with the same data-focus-key', () => {
    const old = button('Card')
    old.setAttribute(FOCUS_KEY_ATTRIBUTE, 'card:1')
    const other = button('Other card')
    other.setAttribute(FOCUS_KEY_ATTRIBUTE, 'card:2')
    old.remove() // the card was re-mounted in another column
    const replacement = button('Card')
    replacement.setAttribute(FOCUS_KEY_ATTRIBUTE, 'card:1')
    let scrollPrevented: boolean | undefined
    const focus = replacement.focus.bind(replacement)
    replacement.focus = (options) => {
      scrollPrevented = options?.preventScroll
      focus(options)
    }

    expect(restoreFocus(old)).toBe(true)
    expect(replacement).toHaveFocus()
    // It may be somewhere else on the page: let the browser scroll it into view.
    expect(scrollPrevented).toBe(false)
  })

  it('does not scroll when the original target is still there, and ignores keys nothing carries', () => {
    const target = button('Opener')
    target.setAttribute(FOCUS_KEY_ATTRIBUTE, 'card:1')
    let scrollPrevented: boolean | undefined
    const focus = target.focus.bind(target)
    target.focus = (options) => {
      scrollPrevented = options?.preventScroll
      focus(options)
    }
    expect(restoreFocus(target)).toBe(true)
    expect(scrollPrevented).toBe(true)

    target.blur()
    target.remove()
    expect(restoreFocus(target)).toBe(false) // the key is gone from the page
  })

  it('still never steals focus from a field when only a replacement exists', () => {
    const old = button('Card')
    old.setAttribute(FOCUS_KEY_ATTRIBUTE, 'card:1')
    old.remove()
    const replacement = button('Card')
    replacement.setAttribute(FOCUS_KEY_ATTRIBUTE, 'card:1')
    const field = document.createElement('input')
    document.body.append(field)
    field.focus()
    expect(restoreFocus(old)).toBe(false)
    expect(field).toHaveFocus()
  })

  it('leaves focus to another open dialog that does not contain the target', () => {
    const target = button('Opener')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.dataset.state = 'open'
    document.body.append(dialog)
    expect(restoreFocus(target)).toBe(false)
    expect(target).not.toHaveFocus()

    const inside = button('Inside', dialog)
    expect(restoreFocus(inside)).toBe(true)
    expect(inside).toHaveFocus()
  })
})

function openDialog(role = 'dialog'): HTMLElement {
  const dialog = document.createElement('div')
  dialog.setAttribute('role', role)
  dialog.dataset.state = 'open'
  document.body.append(dialog)
  return dialog
}

describe('isFocusOwnedElsewhere', () => {
  it('is false on a plain page and when the only open dialog contains the target', () => {
    const target = button('Opener')
    expect(isFocusOwnedElsewhere(target)).toBe(false)
    const modal = openDialog()
    const inside = button('Inside', modal)
    expect(isFocusOwnedElsewhere(inside)).toBe(false)
  })

  it('looks at every open dialog, not only the first one in the document', () => {
    // The task modal (first in the document) is open and holds the target; the search overlay
    // opened after it. Looking only at the first dialog would see nothing wrong.
    const modal = openDialog()
    const more = button('More actions', modal)
    expect(isFocusOwnedElsewhere(more)).toBe(false)
    openDialog()
    expect(isFocusOwnedElsewhere(more)).toBe(true)
  })

  it('ignores dialogs that are closing', () => {
    const target = button('Opener')
    openDialog().dataset.state = 'closed'
    expect(isFocusOwnedElsewhere(target)).toBe(false)
  })
})

describe('restoreFocus with several dialogs', () => {
  it('does not pull focus out of a dialog opened after the one holding the target', () => {
    const modal = openDialog()
    const more = button('More actions', modal)
    const search = openDialog()
    const input = document.createElement('input')
    search.append(input)
    input.focus()
    expect(restoreFocus(more)).toBe(false)
    expect(input).toHaveFocus()
  })
})
