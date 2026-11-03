/**
 * How the host's Radix Dialog reaches the active form: Esc, overlay click and the dialog's own
 * dismiss events call `requestClose` (which asks "Discard changes?" when the form is dirty), and
 * ⌘↵ / Ctrl+↵ anywhere in the dialog calls `submit`.
 */
export interface ModalControls {
  requestClose: () => void
  submit: () => void
}

/** Pluralised count: plural(1, 'subtask') → '1 subtask'; plural(3, 'dependency', 'dependencies'). */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? singular : pluralForm}`
}
