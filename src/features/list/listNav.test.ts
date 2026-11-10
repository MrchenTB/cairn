// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  LIST_COLUMN_HEADER_ATTRIBUTE,
  LIST_GROUP_HEADER_ATTRIBUTE,
  listNavKey,
  listNavProps,
  navItems,
  navStep,
  restoreIndex,
  stepIndex,
} from './listNav'

type Mods = Partial<{
  key: string
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  shiftKey: boolean
  defaultPrevented: boolean
  isComposing: boolean
  keyCode: number
}>

const event = (overrides: Mods = {}) => ({
  key: 'ArrowDown',
  altKey: false,
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  defaultPrevented: false,
  isComposing: false,
  keyCode: 40,
  ...overrides,
})

function stop(tag = 'button'): HTMLElement {
  const element = document.createElement(tag)
  element.setAttribute('data-list-nav', 'task')
  document.body.append(element)
  return element
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('navStep', () => {
  it('maps ArrowDown to +1 and ArrowUp to -1 on a navigation stop', () => {
    const target = stop()
    expect(navStep(event({ key: 'ArrowDown' }), target, false)).toBe(1)
    expect(navStep(event({ key: 'ArrowUp' }), target, false)).toBe(-1)
  })

  it.each(['ArrowLeft', 'ArrowRight', 'Enter', ' ', 'Tab', 'Home', 'End', 'PageDown', 'j', 'k'])(
    'ignores %s',
    (key) => {
      expect(navStep(event({ key }), stop(), false)).toBeNull()
    },
  )

  it.each(['altKey', 'ctrlKey', 'metaKey', 'shiftKey'] as const)('ignores %s + arrow', (flag) => {
    const target = stop()
    expect(navStep(event({ [flag]: true }), target, false)).toBeNull()
    expect(navStep(event({ key: 'ArrowUp', [flag]: true }), target, false)).toBeNull()
  })

  it('ignores an event that was handled already', () => {
    expect(navStep(event({ defaultPrevented: true }), stop(), false)).toBeNull()
  })

  it('ignores IME composition: isComposing, and keyCode 229 (Safari / Windows "Process")', () => {
    const target = stop()
    expect(navStep(event({ isComposing: true }), target, false)).toBeNull()
    expect(navStep(event({ keyCode: 229 }), target, false)).toBeNull()
    expect(navStep(event({ key: 'Process', keyCode: 229 }), target, false)).toBeNull()
    expect(navStep(event({ isComposing: true, keyCode: 229 }), target, false)).toBeNull()
  })

  it('ignores every key while a task is being dragged', () => {
    expect(navStep(event(), stop(), true)).toBeNull()
    expect(navStep(event({ key: 'ArrowUp' }), stop(), true)).toBeNull()
  })

  it('ignores a target that is not a navigation stop', () => {
    const plain = document.createElement('button')
    document.body.append(plain)
    expect(navStep(event(), plain, false)).toBeNull()
    expect(navStep(event(), null, false)).toBeNull()
    expect(navStep(event(), document.body, false)).toBeNull()
    // A control inside a row (the drag handle, the status trigger) is not a stop either.
    const row = stop('div')
    const handle = document.createElement('button')
    row.append(handle)
    expect(navStep(event(), handle, false)).toBeNull()
  })

  it('ignores text fields even when they carry the stop attribute', () => {
    expect(navStep(event(), stop('input'), false)).toBeNull()
    expect(navStep(event(), stop('textarea'), false)).toBeNull()
    expect(navStep(event(), stop('select'), false)).toBeNull()
    const editable = stop('div')
    editable.setAttribute('contenteditable', 'true')
    Object.defineProperty(editable, 'isContentEditable', { value: true })
    expect(navStep(event(), editable, false)).toBeNull()
  })

  it('ignores a stop inside a menu / dialog / listbox, or while an overlay is open', () => {
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)
    const inMenu = document.createElement('button')
    inMenu.setAttribute('data-list-nav', 'task')
    menu.append(inMenu)
    expect(navStep(event(), inMenu, false)).toBeNull()

    document.body.replaceChildren()
    const target = stop()
    expect(navStep(event(), target, false)).toBe(1)
    const open = document.createElement('div')
    open.setAttribute('role', 'dialog')
    open.setAttribute('data-state', 'open')
    document.body.append(open)
    expect(navStep(event(), target, false)).toBeNull()
  })
})

describe('stepIndex', () => {
  it('moves one step in either direction', () => {
    expect(stepIndex(5, 2, 1)).toBe(3)
    expect(stepIndex(5, 2, -1)).toBe(1)
  })

  it('stops at both ends (no wrap-around)', () => {
    expect(stepIndex(5, 4, 1)).toBeNull()
    expect(stepIndex(5, 0, -1)).toBeNull()
    expect(stepIndex(1, 0, 1)).toBeNull()
    expect(stepIndex(1, 0, -1)).toBeNull()
  })

  it('reaches the first and the last item', () => {
    expect(stepIndex(5, 3, 1)).toBe(4)
    expect(stepIndex(5, 1, -1)).toBe(0)
  })

  it('does nothing when the current item is not in the list (index -1) or the list is empty', () => {
    expect(stepIndex(5, -1, 1)).toBeNull()
    expect(stepIndex(5, -1, -1)).toBeNull()
    expect(stepIndex(0, -1, 1)).toBeNull()
    expect(stepIndex(0, 0, 1)).toBeNull()
  })
})

describe('restoreIndex', () => {
  const keys = ['a', 'b', 'c', 'd']

  it('finds the same item again by key, wherever it is now', () => {
    expect(restoreIndex(keys, 'c', 0)).toBe(2)
    expect(restoreIndex(keys, 'a', 3)).toBe(0)
    expect(restoreIndex(keys, 'd', 1)).toBe(3)
  })

  it('takes the item that took its place when the key is gone', () => {
    expect(restoreIndex(['a', 'c', 'd'], 'b', 1)).toBe(1)
    expect(restoreIndex(['b', 'c', 'd'], 'a', 0)).toBe(0)
  })

  it('falls back to the last item when the deleted one was last', () => {
    expect(restoreIndex(['a', 'b', 'c'], 'd', 3)).toBe(2)
    expect(restoreIndex(['a'], 'z', 9)).toBe(0)
  })

  it('clamps a negative index to the first item', () => {
    expect(restoreIndex(keys, 'gone', -1)).toBe(0)
  })

  it('returns null when nothing is left', () => {
    expect(restoreIndex([], 'a', 0)).toBeNull()
  })
})

describe('markers and DOM helpers', () => {
  it('builds stable keys and the attributes of a stop', () => {
    expect(listNavKey.group('c1')).toBe('list:group:c1')
    expect(listNavKey.task('t1')).toBe('list:task:t1')
    expect(listNavKey.milestone('m1')).toBe('list:milestone:m1')
    expect(listNavProps('task', 'list:task:t1')).toEqual({
      'data-list-nav': 'task',
      'data-focus-key': 'list:task:t1',
    })
  })

  it('navItems returns the stops in document order, nothing else', () => {
    const scroller = document.createElement('div')
    scroller.innerHTML = `
      <div ${LIST_COLUMN_HEADER_ATTRIBUTE}></div>
      <div ${LIST_GROUP_HEADER_ATTRIBUTE}><button data-list-nav="group" id="g"></button></div>
      <button id="status"></button>
      <button data-list-nav="task" id="t"></button>
      <button data-list-nav="milestone" id="m"></button>`
    document.body.append(scroller)
    expect(navItems(scroller).map((item) => item.id)).toEqual(['g', 't', 'm'])
  })
})
