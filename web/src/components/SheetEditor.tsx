import { ArrowLineDown, ArrowLineUp, Plus, Trash } from '@phosphor-icons/react'
import { useMemo, useState } from 'react'
import type { Cell, SheetBody } from '../lib/api'
import { columnName, display, evaluateSheet, FormulaError, isFormula, shiftRows } from '../lib/formulas'
import { Popover } from './EditorUI'

const rowId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)

/** One id per row. Sheets saved before row ids existed get r0, r1, ...: the same ids the
    server reads them with, so edits line up with its stored revisions. */
function rowIds(body: SheetBody): string[] {
  if (!body.row_ids) return body.rows.map((_, i) => `r${i}`)
  const seen = new Set<string>()
  return body.rows.map((_, i) => {
    let id = body.row_ids?.[i]
    if (!id || seen.has(id)) id = rowId()
    seen.add(id)
    return id
  })
}

const looksNumeric = (v: string) => v !== '' && !Number.isNaN(Number(v))

/** A grid of cells. Formulas (`=SUM(B1:B4)`) show their result; the cell being edited, and the
    formula bar, show what was typed. The stored sheet always keeps the formula itself. */
export default function SheetEditor({ body, onChange, readOnly }: { body: SheetBody; onChange: (b: SheetBody) => void; readOnly: boolean }) {
  const values = useMemo(() => evaluateSheet(body.rows), [body.rows])
  const ids = useMemo(() => rowIds(body), [body])
  const [editing, setEditing] = useState<string | null>(null) // "r:c" of the focused cell
  const [selected, setSelected] = useState<[number, number] | null>(null)

  const commit = (rows: Cell[][], row_ids: string[]) => onChange({ ...body, rows, row_ids })
  const setCell = (r: number, c: number, value: Cell) =>
    commit(
      body.rows.map((row, i) => (i === r ? row.map((v, j) => (j === c ? value : v)) : row)),
      ids,
    )
  const setColumn = (c: number, name: string) => onChange({ ...body, row_ids: ids, columns: body.columns.map((v, j) => (j === c ? name : v)) })
  const addColumn = () =>
    onChange({ columns: [...body.columns, columnName(body.columns.length % 26)], rows: body.rows.map((r) => [...r, '']), row_ids: ids })

  /** Rows move, so do the formulas pointing at them (A5 becomes A6 below an inserted row). */
  const shifted = (rows: Cell[][], at: number, delta: 1 | -1) => rows.map((row) => row.map((v) => (isFormula(v) ? shiftRows(v, at, delta) : v)))
  const insertRow = (at: number) => {
    const rows = shifted(body.rows, at, 1)
    commit([...rows.slice(0, at), body.columns.map(() => ''), ...rows.slice(at)], [...ids.slice(0, at), rowId(), ...ids.slice(at)])
    setSelected(null)
  }
  const deleteRow = (at: number) => {
    const rows = shifted(
      body.rows.filter((_, i) => i !== at),
      at,
      -1,
    )
    commit(
      rows,
      ids.filter((_, i) => i !== at),
    )
    setSelected(null)
  }

  const [sr, sc] = selected ?? [-1, -1]
  const selectedRaw = selected ? (body.rows[sr]?.[sc] ?? '') : ''

  return (
    <div className="sheet">
      {selected && body.rows[sr] && (
        <div className="sheet-formula-bar">
          <span className="sheet-cell-name">
            {columnName(sc)}
            {sr + 1}
          </span>
          <input
            value={selectedRaw}
            readOnly={readOnly}
            onChange={(e) => setCell(sr, sc, e.target.value)}
            aria-label="Formula bar"
            placeholder={readOnly ? '' : 'Type a value, or = for a formula, e.g. =SUM(B1:B4)'}
            spellCheck={false}
          />
        </div>
      )}
      <div className="sheet-scroll">
        <table className="sheet-table">
          <thead>
            <tr>
              <th className="sheet-corner" aria-hidden="true" />
              {body.columns.map((col, c) => (
                <th key={c}>
                  <input value={col} readOnly={readOnly} onChange={(e) => setColumn(c, e.target.value)} aria-label={`Column ${c + 1} name`} />
                </th>
              ))}
              <th className="sheet-add-col">
                {!readOnly && (
                  <button className="icon-btn" onClick={addColumn} aria-label="Add column" title="Add column">
                    <Plus size={16} weight="bold" />
                  </button>
                )}
              </th>
            </tr>
          </thead>
          <tbody>
            {body.rows.map((row, r) => (
              <tr key={ids[r]}>
                <td className="sheet-rownum">
                  {readOnly ? (
                    r + 1
                  ) : (
                    <RowMenu number={r + 1} onInsert={(below) => insertRow(below ? r + 1 : r)} onDelete={() => deleteRow(r)} />
                  )}
                </td>
                {row.map((cell, c) => {
                  const key = `${r}:${c}`
                  const formula = isFormula(cell)
                  const value = values[r]?.[c]
                  const shown = editing === key || !formula ? String(cell ?? '') : display(value)
                  return (
                    <td key={c}>
                      <input
                        value={shown}
                        readOnly={readOnly}
                        onChange={(e) => setCell(r, c, e.target.value)}
                        onFocus={() => {
                          setEditing(key)
                          setSelected([r, c])
                        }}
                        onBlur={() => setEditing((k) => (k === key ? null : k))}
                        aria-label={`Row ${r + 1}, ${body.columns[c]}`}
                        title={formula ? String(cell) : undefined}
                        spellCheck={!formula}
                        data-formula={formula || undefined}
                        data-error={(formula && value instanceof FormulaError) || undefined}
                        data-numeric={typeof cell === 'number' || (editing !== key && (typeof value === 'number' || looksNumeric(shown)))}
                      />
                    </td>
                  )
                })}
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <button className="btn btn-ghost" onClick={() => insertRow(body.rows.length)}>
          <Plus size={16} weight="bold" /> Add row
        </button>
      )}
    </div>
  )
}

function RowMenu({ number, onInsert, onDelete }: { number: number; onInsert: (below: boolean) => void; onDelete: () => void }) {
  return (
    <Popover
      trigger={(open, toggle) => (
        <button className="sheet-row-btn" aria-haspopup="menu" aria-expanded={open} aria-label={`Row ${number} actions`} onClick={(e) => toggle(e.currentTarget)}>
          {number}
        </button>
      )}
    >
      {(close) => (
        <div className="select-menu" role="menu">
          <button role="menuitem" className="select-option" onClick={() => (onInsert(false), close())}>
            <span className="select-label">
              <ArrowLineUp size={15} /> Insert row above
            </span>
          </button>
          <button role="menuitem" className="select-option" onClick={() => (onInsert(true), close())}>
            <span className="select-label">
              <ArrowLineDown size={15} /> Insert row below
            </span>
          </button>
          <hr className="menu-rule" />
          <button role="menuitem" className="select-option" data-danger onClick={() => (onDelete(), close())}>
            <span className="select-label">
              <Trash size={15} /> Delete row
            </span>
          </button>
        </div>
      )}
    </Popover>
  )
}
