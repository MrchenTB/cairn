import { afterEach, describe, expect, it } from 'vitest'
import { getFocusReturnTarget, restoreFocus } from './focus'

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
