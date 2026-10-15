import {
  ArrowsMerge,
  ArrowsSplit,
  CaretDown,
  ColumnsPlusLeft,
  ColumnsPlusRight,
  Rows,
  RowsPlusBottom,
  RowsPlusTop,
  Table,
  Trash,
} from '@phosphor-icons/react'
import { useEditorState, type Editor } from '@tiptap/react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useState } from 'react'
import { TOP_OFFSET } from '../lib/scroll'
import { canMergeCells, findTable } from '../lib/table'
import { Float, Popover, Tool } from './EditorUI'
import { useTooltip } from './useTooltip'

const GRID = 8

/** Word-style "Insert table": hover a grid to pick rows × columns. */
export function TableInsert({ editor }: { editor: Editor }) {
  const [hover, setHover] = useState({ rows: 0, cols: 0 })
  const { bind, node } = useTooltip({ label: 'Table', hint: 'Insert a table; pick its size on the grid' })
  return (
    <Popover
      trigger={(open, toggle) => (
        <>
          <button
            type="button"
            className="tool"
            data-active={open || undefined}
            aria-label="Insert table"
            aria-expanded={open}
            {...bind}
            onMouseDown={(e) => {
              e.preventDefault()
              bind.onMouseDown()
            }}
            onClick={(e) => toggle(e.currentTarget)}
          >
            <Table size={18} />
          </button>
          {node}
        </>
      )}
    >
      {(close) => (
        <div className="table-picker" onMouseLeave={() => setHover({ rows: 0, cols: 0 })}>
          <div className="table-picker-grid" style={{ gridTemplateColumns: `repeat(${GRID}, 1fr)` }} role="grid" aria-label="Table size">
            {Array.from({ length: GRID * GRID }, (_, i) => {
              const r = Math.floor(i / GRID) + 1
              const c = (i % GRID) + 1
              return (
                <button
                  key={i}
                  type="button"
                  className="table-picker-cell"
                  data-on={(r <= hover.rows && c <= hover.cols) || undefined}
                  aria-label={`${r} by ${c} table`}
                  onMouseEnter={() => setHover({ rows: r, cols: c })}
                  onFocus={() => setHover({ rows: r, cols: c })}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    editor.chain().focus().insertTable({ rows: r, cols: c, withHeaderRow: r > 1 }).run()
                    close()
                  }}
                />
              )
            })}
          </div>
          <p className="table-picker-label">{hover.rows ? `${hover.rows} × ${hover.cols} table` : 'Pick a size'}</p>
        </div>
      )}
    </Popover>
  )
}

function useTableState(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const found = e.isDestroyed ? undefined : findTable(e.state.selection)
      return {
        pos: found ? found.pos : null,
        canMerge: found ? canMergeCells(e) : false,
        canSplit: found ? e.can().splitCell() : false,
        header: found ? found.node.firstChild?.firstChild?.type.name === 'tableHeader' : false,
      }
    },
  })
}

/** Row, column and cell tools, floating above the table the cursor is in. */
export function TableBar({ editor }: { editor: Editor }) {
  const t = useTableState(editor)
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null)
  // Opening a doc can leave the cursor in a table; wait until the reader works in the doc.
  const [engaged, setEngaged] = useState(false)
  useEffect(() => {
    const dom = editor.view.dom
    const engage = () => setEngaged(true)
    dom.addEventListener('mousedown', engage)
    dom.addEventListener('keydown', engage)
    return () => {
      dom.removeEventListener('mousedown', engage)
      dom.removeEventListener('keydown', engage)
    }
  }, [editor])
  const c = () => editor.chain().focus()

  useLayoutEffect(() => {
    if (t.pos === null) return
    let frame = 0
    const place = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const dom = t.pos === null ? null : (editor.view.nodeDOM(t.pos) as HTMLElement | null)
        if (!dom?.getBoundingClientRect) return setRect(null)
        const box = dom.getBoundingClientRect()
        const top = Math.max(box.top - 48, TOP_OFFSET + 6)
        // Hide once the table has scrolled out of view.
        if (box.bottom < TOP_OFFSET + 40 || box.top > window.innerHeight) return setRect(null)
        setRect({ top, left: box.left, width: box.width })
      })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    const observer = new ResizeObserver(place)
    observer.observe(editor.view.dom)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      observer.disconnect()
    }
  }, [editor, t.pos])

  const show = engaged && rect !== null && t.pos !== null
  return (
    <Float>
      <AnimatePresence>
        {show && (
          <motion.div
            key="table-bar"
            className="table-bar"
            role="toolbar"
            aria-label="Table"
            style={{ top: rect.top, left: rect.left + rect.width / 2 }}
            initial={{ opacity: 0, y: 6, x: '-50%', scale: 0.96 }}
            animate={{ opacity: 1, y: 0, x: '-50%', scale: 1 }}
            exit={{ opacity: 0, y: 4, x: '-50%', scale: 0.97, transition: { duration: 0.12 } }}
            transition={{ type: 'spring', stiffness: 520, damping: 36 }}
          >
            <Tool icon={RowsPlusTop} tip={{ label: 'Row above' }} onClick={() => c().addRowBefore().run()} />
            <Tool icon={RowsPlusBottom} tip={{ label: 'Row below' }} onClick={() => c().addRowAfter().run()} />
            <Tool icon={ColumnsPlusLeft} tip={{ label: 'Column left' }} onClick={() => c().addColumnBefore().run()} />
            <Tool icon={ColumnsPlusRight} tip={{ label: 'Column right' }} onClick={() => c().addColumnAfter().run()} />
            <span className="tool-divider" />
            <Tool icon={ArrowsMerge} tip={{ label: 'Merge cells', hint: 'Drag across cells in a row to select them first' }} disabled={!t.canMerge} onClick={() => c().mergeCells().run()} />
            <Tool icon={ArrowsSplit} tip={{ label: 'Split cell', hint: 'Undo a merge' }} disabled={!t.canSplit} onClick={() => c().splitCell().run()} />
            <Tool icon={Rows} tip={{ label: 'Header row', hint: 'Style the first row as column titles' }} active={t.header} onClick={() => c().toggleHeaderRow().run()} />
            <span className="tool-divider" />
            <DeleteMenu editor={editor} />
          </motion.div>
        )}
      </AnimatePresence>
    </Float>
  )
}

function DeleteMenu({ editor }: { editor: Editor }) {
  const { bind, node } = useTooltip({ label: 'Delete', hint: 'Remove a row, a column or the whole table' })
  const run = (fn: () => void, close: () => void) => {
    fn()
    close()
  }
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <>
          <button
            type="button"
            className="tool tool-wide"
            data-active={open || undefined}
            aria-label="Delete"
            aria-expanded={open}
            {...bind}
            onMouseDown={(e) => {
              e.preventDefault()
              bind.onMouseDown()
            }}
            onClick={(e) => toggle(e.currentTarget)}
          >
            <Trash size={18} />
            <CaretDown size={10} weight="bold" />
          </button>
          {node}
        </>
      )}
    >
      {(close) => (
        <div className="menu-list">
          <button className="cm-item" onMouseDown={(e) => e.preventDefault()} onClick={() => run(() => editor.chain().focus().deleteRow().run(), close)}>
            Delete row
          </button>
          <button className="cm-item" onMouseDown={(e) => e.preventDefault()} onClick={() => run(() => editor.chain().focus().deleteColumn().run(), close)}>
            Delete column
          </button>
          <button className="cm-item cm-danger" onMouseDown={(e) => e.preventDefault()} onClick={() => run(() => editor.chain().focus().deleteTable().run(), close)}>
            Delete table
          </button>
        </div>
      )}
    </Popover>
  )
}
