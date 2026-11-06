/**
 * How the host's Radix Dialog reaches the active form: Esc, overlay click and the dialog's own
 * dismiss events call `requestClose` (edit mode keeps the changes and closes; create mode asks
 * "Discard changes?" when it holds work), and ⌘↵ / Ctrl+↵ anywhere in the dialog calls `submit`.
 */
export interface ModalControls {
  requestClose: () => void
  submit: () => void
  /** Puts focus back on the form's first field (after a prompt that did not move it there). */
  focus: () => void
}

/** Pluralised count: plural(1, 'subtask') → '1 subtask'; plural(3, 'dependency', 'dependencies'). */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`
}
