/** Finding an open inline "Add …" row in the DOM (see the `rowKey` prop of InlineCreate). */

/** The text field of the open inline row `rowKey`, or null when that row is not open. */
export function inlineRowInput(rowKey: string): HTMLInputElement | null {
  for (const element of document.querySelectorAll<HTMLElement>('[data-inline-row]')) {
    if (element.dataset.inlineRow === rowKey) return element.querySelector('input')
  }
  return null
}
