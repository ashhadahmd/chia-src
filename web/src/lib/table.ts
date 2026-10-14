/* Tables in paged docs. Page breaks are floated boxes that text flows around; a whole table
   can't flow around them, so each row is laid out as its own fixed-layout table (see App.css)
   and tables break between rows, like Word. Cell widths therefore travel on the cells. */
import { TableCell, TableHeader } from '@tiptap/extension-table'
import { CellSelection } from '@tiptap/pm/tables'
import { findParentNode, mergeAttributes, type Editor } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'

/** The table around the selection, if any. */
export const findTable = findParentNode((n) => n.type.name === 'table')

/** colspan/rowspan of 1 are the default; leave them out of the HTML like Tiptap does. */
function cellAttrs(node: PMNode, attrs: Record<string, unknown>) {
  const out = mergeAttributes(attrs, { style: widthStyle(node) })
  if (out.colspan === 1 || out.colspan === '1') delete out.colspan
  if (out.rowspan === 1 || out.rowspan === '1') delete out.rowspan
  return out
}

function widthStyle(node: PMNode): string | undefined {
  const widths = node.attrs.colwidth as number[] | null
  if (!widths || widths.length !== node.attrs.colspan || widths.some((w) => !w)) return undefined
  return `width: ${widths.reduce((a, b) => a + b, 0)}px`
}

export const ChiaTableCell = TableCell.extend({
  renderHTML({ node, HTMLAttributes }) {
    return ['td', cellAttrs(node, HTMLAttributes), 0]
  },
})

export const ChiaTableHeader = TableHeader.extend({
  renderHTML({ node, HTMLAttributes }) {
    return ['th', cellAttrs(node, HTMLAttributes), 0]
  },
})

/** Rows are laid out separately, so merges stay within one row. */
export function canMergeCells(editor: Editor): boolean {
  const sel = editor.state.selection
  if (!(sel instanceof CellSelection) || !editor.can().mergeCells()) return false
  return sel.$anchorCell.index(-1) === sel.$headCell.index(-1)
}
