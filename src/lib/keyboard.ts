/**
 * Keyboard shortcut engine: ONE document-level keydown listener dispatching to registered
 * bindings, so global and view-scoped shortcuts share the same rules.
 *
 * Binding syntax
 * - chord: modifiers + key joined by '+': 'mod+k' (⌘ on macOS, Ctrl elsewhere), 'shift+enter', '['
 * - sequence: chords separated by a space: 'g o' (press G, then O within 1.2 s)
 * - symbol keys ('?', '[', '/') ignore Shift (it depends on the keyboard layout)
 *
 * Rules applied to every binding (opt out per binding):
 * - never fires while typing in an input/textarea/select/contenteditable (`allowInInput`)
 * - never fires while a dialog, popover or menu is open or focused (`allowInModal`)
 * - ignores IME composition (CJK input), auto-repeat (`allowRepeat`) and handled events
 * - when several bindings match, the most recently registered one wins (view-scoped beats global)
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'

export const isMac: boolean =
  typeof navigator !== 'undefined' &&
  /mac|iphone|ipad|ipod/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
      navigator.platform ||
      navigator.userAgent,
  )

const SEQUENCE_TIMEOUT_MS = 1200

const MODIFIER_KEYS = new Set([
  'shift',
  'control',
  'meta',
  'alt',
  'capslock',
  'fn',
  'os',
  'altgraph',
])

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  return: 'enter',
  space: ' ',
  spacebar: ' ',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  del: 'delete',
  plus: '+',
}

export interface Chord {
  key: string
  mod: boolean
  ctrl: boolean
  meta: boolean
  alt: boolean
  /** null = Shift state is ignored (symbol keys). */
  shift: boolean | null
}

function isSymbolKey(key: string): boolean {
  return key.length === 1 && !/[a-z0-9 ]/.test(key)
}

/** Parses 'mod+k' / 'g o' / '?' into a sequence of chords. */
export function parseHotkey(binding: string): Chord[] {
  return binding
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      const tokens = part.toLowerCase().split('+')
      // 'mod++' style is not supported; a trailing empty token means the key itself was '+'.
      const rawKey = tokens.pop() || '+'
      const key = KEY_ALIASES[rawKey] ?? rawKey
      const chord: Chord = {
        key,
        mod: false,
        ctrl: false,
        meta: false,
        alt: false,
        shift: isSymbolKey(key) ? null : false,
      }
      for (const token of tokens) {
        if (token === 'mod') chord.mod = true
        else if (token === 'ctrl' || token === 'control') chord.ctrl = true
        else if (token === 'meta' || token === 'cmd' || token === 'command') chord.meta = true
        else if (token === 'alt' || token === 'option') chord.alt = true
        else if (token === 'shift') chord.shift = true
      }
      return chord
    })
}

type KeyLike = Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>

function normalizeKey(key: string): string {
  return key.toLowerCase()
}

/** True when the keyboard event matches one chord (exact modifier match). */
export function matchesChord(event: KeyLike, chord: Chord): boolean {
  const key = normalizeKey(event.key)
  let keyMatches = key === chord.key
  // Letters on non-Latin layouts: fall back to the physical key (KeyK → 'k').
  if (!keyMatches && /^[a-z]$/.test(chord.key) && !/^[a-z]$/.test(key)) {
    keyMatches = event.code === `Key${chord.key.toUpperCase()}`
  }
  if (!keyMatches) return false

  const wantMeta = chord.meta || (chord.mod && isMac)
  const wantCtrl = chord.ctrl || (chord.mod && !isMac)
  if (event.metaKey !== wantMeta || event.ctrlKey !== wantCtrl) return false
  if (event.altKey !== chord.alt) return false
  if (chord.shift !== null && event.shiftKey !== chord.shift) return false
  return true
}

const NON_TEXT_INPUTS = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
])

/** True for elements where single-key shortcuts would steal typing. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((target as HTMLInputElement).type)
  return target.closest('[contenteditable=""],[contenteditable="true"]') !== null
}

const OVERLAY_SELECTOR = '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]'
const OPEN_OVERLAY_SELECTOR =
  '[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"],[role="menu"][data-state="open"],[role="listbox"][data-state="open"]'

/** True when focus is inside, or the page shows, a dialog / popover / menu / listbox. */
export function isOverlayActive(target: EventTarget | null): boolean {
  if (typeof document === 'undefined') return false
  if (target instanceof Element && target.closest(OVERLAY_SELECTOR)) return true
  return document.querySelector(OPEN_OVERLAY_SELECTOR) !== null
}

// ---------------------------------------------------------------------------
// Registry + dispatcher
// ---------------------------------------------------------------------------

export interface HotkeyOptions {
  /** Default true. */
  enabled?: boolean
  /** Fire even while typing in a text field (e.g. ⌘K). */
  allowInInput?: boolean
  /** Fire even while a dialog/popover/menu is open or focused (e.g. ⌘K). */
  allowInModal?: boolean
  /** Fire on auto-repeat (key held down). */
  allowRepeat?: boolean
  /** Call preventDefault() when the binding fires (default true). */
  preventDefault?: boolean
  /** Shown in the shortcuts dialog when set. */
  description?: string
  /** Group heading in the shortcuts dialog (e.g. 'General', 'Navigation', 'Current view'). */
  group?: string
}

interface Registration {
  id: number
  bindings: string[]
  sequences: Chord[][]
  handler: (event: KeyboardEvent) => void
  options: HotkeyOptions
}

/** A registered shortcut with a description, for help UIs. */
export interface RegisteredHotkey {
  id: number
  keys: string[]
  description: string
  group: string
}

let nextId = 1
let registrations: Registration[] = []
let pending: KeyLike[] = []
let pendingAt = 0
let listening = false
let snapshot: RegisteredHotkey[] = []
const subscribers = new Set<() => void>()

function emitChange() {
  snapshot = registrations
    .filter((r) => r.options.description && r.options.enabled !== false)
    .map((r) => ({
      id: r.id,
      keys: r.bindings,
      description: r.options.description as string,
      group: r.options.group ?? 'General',
    }))
  for (const notify of subscribers) notify()
}

function sequenceMatches(sequence: Chord[], history: KeyLike[], exact: boolean): boolean {
  if (exact ? sequence.length !== history.length : sequence.length <= history.length) return false
  return history.every((event, index) => matchesChord(event, sequence[index]))
}

function describe(event: KeyboardEvent): KeyLike {
  const { key, code, ctrlKey, metaKey, altKey, shiftKey } = event
  return { key, code, ctrlKey, metaKey, altKey, shiftKey }
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) return
  if (MODIFIER_KEYS.has(normalizeKey(event.key))) return

  const inInput = isEditableTarget(event.target)
  const inOverlay = isOverlayActive(event.target)
  const eligible = registrations.filter(
    (r) =>
      r.options.enabled !== false &&
      (!inInput || r.options.allowInInput) &&
      (!inOverlay || r.options.allowInModal) &&
      (!event.repeat || r.options.allowRepeat),
  )

  const now = Date.now()
  if (pending.length > 0 && now - pendingAt > SEQUENCE_TIMEOUT_MS) pending = []

  const attempt = (history: KeyLike[]): boolean => {
    // Most recent registration wins.
    for (let i = eligible.length - 1; i >= 0; i--) {
      const registration = eligible[i]
      if (registration.sequences.some((s) => sequenceMatches(s, history, true))) {
        pending = []
        if (registration.options.preventDefault !== false) event.preventDefault()
        registration.handler(event)
        return true
      }
    }
    if (eligible.some((r) => r.sequences.some((s) => sequenceMatches(s, history, false)))) {
      pending = history
      pendingAt = now
      return true
    }
    return false
  }

  const current = describe(event)
  if (pending.length > 0 && attempt([...pending, current])) return
  pending = []
  attempt([current])
}

function ensureListener() {
  if (listening || typeof document === 'undefined') return
  document.addEventListener('keydown', handleKeyDown)
  listening = true
}

/**
 * Registers bindings imperatively; returns the unregister function. Prefer `useHotkeys` in
 * components.
 */
export function registerHotkey(
  bindings: string | string[],
  handler: (event: KeyboardEvent) => void,
  options: HotkeyOptions = {},
): () => void {
  const list = (Array.isArray(bindings) ? bindings : [bindings]).filter(Boolean)
  const registration: Registration = {
    id: nextId++,
    bindings: list,
    sequences: list.map(parseHotkey),
    handler,
    options,
  }
  registrations = [...registrations, registration]
  ensureListener()
  emitChange()
  return () => {
    registrations = registrations.filter((r) => r !== registration)
    emitChange()
  }
}

/**
 * Registers keyboard shortcuts for the lifetime of the calling component. The handler may
 * change every render; bindings/options are compared by value.
 */
export function useHotkeys(
  bindings: string | string[],
  handler: (event: KeyboardEvent) => void,
  options: HotkeyOptions = {},
): void {
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })
  const key = Array.isArray(bindings) ? bindings.join('\n') : bindings
  const { enabled, allowInInput, allowInModal, allowRepeat, preventDefault, description, group } =
    options
  useEffect(() => {
    if (enabled === false) return undefined
    return registerHotkey(key.split('\n'), (event) => handlerRef.current(event), {
      allowInInput,
      allowInModal,
      allowRepeat,
      preventDefault,
      description,
      group,
    })
  }, [key, enabled, allowInInput, allowInModal, allowRepeat, preventDefault, description, group])
}

function subscribe(callback: () => void) {
  subscribers.add(callback)
  return () => {
    subscribers.delete(callback)
  }
}
function getSnapshot() {
  return snapshot
}

/** Live list of described shortcuts (for the shortcuts help dialog). */
export function useRegisteredHotkeys(): RegisteredHotkey[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/** Test helper: drops every registration and pending sequence. */
export function resetHotkeysForTests() {
  registrations = []
  pending = []
  emitChange()
}

// ---------------------------------------------------------------------------
// Display
// ---------------------------------------------------------------------------

const DISPLAY_NAMES: Record<string, [mac: string, other: string]> = {
  mod: ['⌘', 'Ctrl'],
  meta: ['⌘', 'Win'],
  cmd: ['⌘', 'Win'],
  ctrl: ['⌃', 'Ctrl'],
  control: ['⌃', 'Ctrl'],
  alt: ['⌥', 'Alt'],
  option: ['⌥', 'Alt'],
  shift: ['⇧', 'Shift'],
  enter: ['↵', 'Enter'],
  return: ['↵', 'Enter'],
  escape: ['Esc', 'Esc'],
  esc: ['Esc', 'Esc'],
  backspace: ['⌫', 'Backspace'],
  delete: ['Del', 'Del'],
  tab: ['Tab', 'Tab'],
  space: ['Space', 'Space'],
  arrowup: ['↑', '↑'],
  arrowdown: ['↓', '↓'],
  arrowleft: ['←', '←'],
  arrowright: ['→', '→'],
  up: ['↑', '↑'],
  down: ['↓', '↓'],
  left: ['←', '←'],
  right: ['→', '→'],
}

/** Display tokens per chord: 'mod+k' → [['⌘', 'K']] on macOS, [['Ctrl', 'K']] elsewhere. */
export function formatHotkey(binding: string): string[][] {
  return binding
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) =>
      part.split(/\+(?!$)/).map((token) => {
        const lower = token.toLowerCase()
        const names = DISPLAY_NAMES[lower]
        if (names) return isMac ? names[0] : names[1]
        return token.length === 1 ? token.toUpperCase() : token[0].toUpperCase() + token.slice(1)
      }),
    )
}

/** Plain-text label, e.g. '⌘K', 'Ctrl+K', 'G then O' — for aria-keyshortcuts-like hints. */
export function hotkeyLabel(binding: string): string {
  return formatHotkey(binding)
    .map((chord) => chord.join(isMac ? '' : '+'))
    .join(' then ')
}
