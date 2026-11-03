/**
 * Last input modality ('keyboard' | 'pointer'), mirrored on <html data-input-modality>.
 *
 * Why: after a pointer interaction, Radix moves focus programmatically (a menu, popover or
 * dialog returns focus to its trigger) and Chrome keeps :focus-visible on for such focus. That
 * leaves a focus ring on the trigger and opens its tooltip on focus although the user never
 * touched the keyboard. Knowing the modality lets the tooltip ignore focus-driven opens after
 * pointer input, and lets CSS hide those trigger rings until the next key press (src/index.css).
 * Any key press switches back to 'keyboard', so keyboard users always get rings and tooltips.
 */

export type InputModality = 'keyboard' | 'pointer'

export const INPUT_MODALITY_ATTRIBUTE = 'data-input-modality'

let modality: InputModality = 'keyboard'
let installedOn: Document | null = null

function update(next: InputModality) {
  if (modality === next) return
  modality = next
  installedOn?.documentElement.setAttribute(INPUT_MODALITY_ATTRIBUTE, next)
}

/** Starts tracking on `target` (idempotent). Capture-phase listeners run before any handler. */
export function installInputModality(target: Document | undefined = globalThis.document): void {
  if (!target || installedOn === target) return
  installedOn = target
  target.documentElement.setAttribute(INPUT_MODALITY_ATTRIBUTE, modality)
  target.addEventListener('keydown', () => update('keyboard'), true)
  target.addEventListener('pointerdown', () => update('pointer'), true)
}

/** The modality of the most recent key press or pointer press ('keyboard' before any input). */
export function getInputModality(): InputModality {
  installInputModality()
  return modality
}
