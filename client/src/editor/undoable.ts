/**
 * Deletes that Ctrl+Z can bring back happen immediately, with an "Undo" button in a message
 * instead of a confirmation. The change is kept as its own undo step, and the button only
 * undoes it while it is still the latest thing you did (otherwise it points you to Ctrl+Z).
 */
import type { Editor } from '@tiptap/core'
import { yUndoPluginKey } from '@tiptap/y-tiptap'
import { toast } from '../util'
import { K, keyLabel } from './shortcuts'

export function withUndo(editor: Editor | null, message: string, run: () => void) {
  const um = editor ? yUndoPluginKey.getState(editor.state)?.undoManager : null
  um?.stopCapturing()
  run()
  um?.stopCapturing()
  const item = um?.undoStack[um.undoStack.length - 1]
  if (!um || !item) return toast(message)
  toast(message, undefined, {
    label: 'Undo',
    run: () => {
      if (um.undoStack[um.undoStack.length - 1] === item) um.undo()
      else toast(`You’ve made other changes since. Press ${keyLabel(K.undo)} to step back to it.`)
    },
  })
}
