import type { Editor } from '@tiptap/react'

export const TOP_OFFSET = 150 // sticky editor bar plus breathing room

/** Scroll the window so a document position sits below the top bar, or a third of the way down. */
export function scrollToPos(editor: Editor, pos: number, block: 'top' | 'center' = 'top') {
  const coords = editor.view.coordsAtPos(Math.min(pos, editor.state.doc.content.size))
  const offset = block === 'top' ? TOP_OFFSET : window.innerHeight / 3
  window.scrollTo({ top: coords.top + window.scrollY - offset, behavior: 'smooth' })
}
