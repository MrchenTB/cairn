/// <reference lib="dom" />
/**
 * Real input-method (IME) composition for Playwright, through a CDP session.
 *
 * Playwright's own keyboard cannot compose: `keyboard.type` sends plain key events. The browser
 * does expose the two calls a real input method uses, and this wraps them so a test reads like a
 * person with a Zhuyin / Pinyin keyboard:
 *
 *   Input.imeSetComposition  the pre-edit string (underlined text): compositionstart / update,
 *                            `input` events with isComposing = true, the string IS in the field
 *   Input.insertText         the commit: compositionend with the final text
 *
 * Keys the input method consumes (Enter / Esc / arrows while a candidate list is open) reach the
 * page as `keydown` with keyCode 229 and NO keypress, so the browser itself never submits a form
 * or inserts a line break for them. `Input.dispatchKeyEvent` with type rawKeyDown and virtual key
 * 229 reproduces exactly that; a plain `keyboard.press('Enter')` during a composition does not
 * (it carries keyCode 13, the browser then runs Enter's default action), so never use it for an
 * IME key.
 *
 * Two orders exist in the wild and both are covered:
 *   Chrome / Edge / Firefox  keydown(229, isComposing) -> compositionend -> keyup
 *   Safari                   compositionend -> keydown(229, isComposing = FALSE) -> keyup
 */
import type { CDPSession, Page } from '@playwright/test'

/** `code` and the real virtual-key code (the key-up carries it) of the keys an IME takes. */
const KEYS = {
  Enter: { code: 'Enter', vk: 13 },
  Escape: { code: 'Escape', vk: 27 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  Tab: { code: 'Tab', vk: 9 },
  Space: { code: 'Space', vk: 32 },
  Backspace: { code: 'Backspace', vk: 8 },
} as const

export type ImeKey = keyof typeof KEYS

/** How the browser names a key the input method handled: macOS keeps the name, Windows says "Process". */
export type ImeKeyNaming = 'name' | 'process'

export class Ime {
  private readonly cdp: CDPSession

  private constructor(cdp: CDPSession) {
    this.cdp = cdp
  }

  static async attach(page: Page): Promise<Ime> {
    return new Ime(await page.context().newCDPSession(page))
  }

  /** Shows (or updates) the pre-edit string in the focused field. */
  async compose(text: string): Promise<void> {
    await this.cdp.send('Input.imeSetComposition', {
      text,
      selectionStart: text.length,
      selectionEnd: text.length,
    })
  }

  /** The IME gives up the pre-edit string (compositionend with empty data). */
  async cancel(): Promise<void> {
    await this.cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  }

  /** The IME commits `text` (a candidate was picked): compositionend. */
  async commit(text: string): Promise<void> {
    await this.cdp.send('Input.insertText', { text })
  }

  /** A key the input method handles itself: keydown, keyCode 229, no keypress. */
  async handle(key: ImeKey, naming: ImeKeyNaming = 'name'): Promise<void> {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 229,
      nativeVirtualKeyCode: 229,
      key: naming === 'process' ? 'Process' : key === 'Space' ? ' ' : key,
      code: KEYS[key].code,
    })
  }

  async release(key: ImeKey): Promise<void> {
    await this.cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      windowsVirtualKeyCode: KEYS[key].vk,
      nativeVirtualKeyCode: KEYS[key].vk,
      key: key === 'Space' ? ' ' : key,
      code: KEYS[key].code,
    })
  }

  /** Enter picks the candidate. Chrome order: keydown(229, composing), then compositionend. */
  async confirmWithEnter(text: string, naming: ImeKeyNaming = 'name'): Promise<void> {
    await this.handle('Enter', naming)
    await this.commit(text)
    await this.release('Enter')
  }

  /** Same, in Safari's order: compositionend first, THEN keydown(229) with isComposing = false. */
  async confirmWithEnterSafari(text: string, naming: ImeKeyNaming = 'name'): Promise<void> {
    await this.commit(text)
    await this.handle('Enter', naming)
    await this.release('Enter')
  }

  /** Esc drops the pre-edit string. Chrome order. */
  async cancelWithEsc(naming: ImeKeyNaming = 'name'): Promise<void> {
    await this.handle('Escape', naming)
    await this.cancel()
    await this.release('Escape')
  }

  /** Same, in Safari's order. */
  async cancelWithEscSafari(naming: ImeKeyNaming = 'name'): Promise<void> {
    await this.cancel()
    await this.handle('Escape', naming)
    await this.release('Escape')
  }

  /**
   * Types `text` the way a Zhuyin / Pinyin user does: a pre-edit string that grows, then the
   * candidate is picked (`commit` alone = mouse / number key, `enter` = Enter, `safari` = Enter in
   * Safari's order). The caller decides what the page may do in between.
   */
  async type(
    text: string,
    preedit: readonly string[],
    how: 'commit' | 'enter' | 'safari' = 'commit',
  ): Promise<void> {
    for (const step of preedit) await this.compose(step)
    if (how === 'enter') await this.confirmWithEnter(text)
    else if (how === 'safari') await this.confirmWithEnterSafari(text)
    else await this.commit(text)
  }
}
