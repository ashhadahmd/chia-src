import { ArrowLeft, Check, CircleNotch, CloudCheck, CloudSlash, Plus, Printer, Robot, Trash, WarningCircle } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import DocEditor from '../components/DocEditor'
import ExportMenu, { type DocActions } from '../components/ExportMenu'
import { api, type Cell, type Doc, type GoogleStatus, type SheetBody, type SlidesBody } from '../lib/api'
import { KINDS, softSpring } from '../lib/kinds'

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

const SAVED_SHOWN_MS = 2500 // "Saved" stays this long, then the status line folds away

/** Debounced autosave: batches title/content edits and PATCHes after a pause. */
function useAutosave(id: string | undefined, onSaved: () => void) {
  const [state, setState] = useState<SaveState>('idle')
  const pending = useRef<{ title?: string; content?: Doc['content'] }>({})
  const timer = useRef<number | undefined>(undefined)
  const hide = useRef<number | undefined>(undefined)

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current)
    if (!id || Object.keys(pending.current).length === 0) return
    const patch = pending.current
    pending.current = {}
    setState('saving')
    try {
      await api.updateDocument(id, patch)
      // Edits made while this request ran are already queued and keep showing "Saving".
      if (Object.keys(pending.current).length === 0) {
        setState('saved')
        hide.current = window.setTimeout(() => setState('idle'), SAVED_SHOWN_MS)
      }
      onSaved()
    } catch {
      setState('error')
    }
  }, [id, onSaved])

  const queue = useCallback(
    (patch: { title?: string; content?: Doc['content'] }) => {
      pending.current = { ...pending.current, ...patch }
      window.clearTimeout(hide.current)
      setState('saving') // from the first keystroke, so the reader sees it syncing
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(flush, 650)
    },
    [flush],
  )

  useEffect(() => () => void flush(), [flush])
  useEffect(() => () => window.clearTimeout(hide.current), [])
  return { state, queue, flush }
}

const SAVE_LABELS = {
  saving: { icon: <CircleNotch size={14} className="spin" />, text: 'Saving…' },
  saved: { icon: <Check size={14} weight="bold" />, text: 'Saved' },
  error: { icon: <WarningCircle size={14} weight="fill" />, text: 'Not saved' },
}

/** Stays mounted from "Saving…" to "Saved" so only the icon and words change, not the whole line. */
function SaveIndicator({ state }: { state: SaveState }) {
  if (state === 'idle') return null
  const { icon, text } = SAVE_LABELS[state]
  return (
    <span className="save-state" data-state={state} role="status">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span key={state} className="save-icon" initial={{ opacity: 0, scale: 0.6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.6 }} transition={{ duration: 0.16 }}>
          {icon}
        </motion.span>
      </AnimatePresence>
      {text}
    </span>
  )
}

function DriveBadge({ google, doc }: { google: GoogleStatus | null; doc: Doc }) {
  if (!google?.connected) return null
  if (doc.backup_error)
    return (
      <span className="drive-badge" data-state="error" title={doc.backup_error}>
        <CloudSlash size={16} weight="fill" /> Backup failed
      </span>
    )
  return doc.drive_url ? (
    <a className="drive-badge" href={doc.drive_url} target="_blank" rel="noopener noreferrer" title={`Backed up to ${google.email}'s Drive`}>
      <CloudCheck size={16} weight="fill" /> Drive
    </a>
  ) : (
    <span className="drive-badge" title="Backing up to Drive shortly">
      <CloudCheck size={16} /> Drive
    </span>
  )
}

function SheetEditor({ body, onChange }: { body: SheetBody; onChange: (b: SheetBody) => void }) {
  const setCell = (r: number, c: number, value: Cell) =>
    onChange({ ...body, rows: body.rows.map((row, i) => (i === r ? row.map((v, j) => (j === c ? value : v)) : row)) })
  const setColumn = (c: number, name: string) => onChange({ ...body, columns: body.columns.map((v, j) => (j === c ? name : v)) })
  const addRow = () => onChange({ ...body, rows: [...body.rows, body.columns.map(() => '')] })
  const addColumn = () =>
    onChange({ columns: [...body.columns, String.fromCharCode(65 + (body.columns.length % 26))], rows: body.rows.map((r) => [...r, '']) })

  return (
    <div className="sheet">
      <div className="sheet-scroll">
        <table className="sheet-table">
          <thead>
            <tr>
              <th className="sheet-corner" aria-hidden="true" />
              {body.columns.map((col, c) => (
                <th key={c}>
                  <input value={col} onChange={(e) => setColumn(c, e.target.value)} aria-label={`Column ${c + 1} name`} />
                </th>
              ))}
              <th className="sheet-add-col">
                <button className="icon-btn" onClick={addColumn} aria-label="Add column" title="Add column">
                  <Plus size={16} weight="bold" />
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {body.rows.map((row, r) => (
              <tr key={r}>
                <td className="sheet-rownum">{r + 1}</td>
                {row.map((cell, c) => (
                  <td key={c}>
                    <input
                      value={cell ?? ''}
                      onChange={(e) => setCell(r, c, e.target.value)}
                      aria-label={`Row ${r + 1}, ${body.columns[c]}`}
                      data-numeric={typeof cell === 'number' || (cell !== '' && cell !== null && !Number.isNaN(Number(cell)))}
                    />
                  </td>
                ))}
                <td />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button className="btn btn-ghost" onClick={addRow}>
        <Plus size={16} weight="bold" /> Add row
      </button>
    </div>
  )
}

function SlidesEditor({ body, onChange }: { body: SlidesBody; onChange: (b: SlidesBody) => void }) {
  const [current, setCurrent] = useState(0)
  const slides = body.slides.length ? body.slides : [{ title: '', body: '' }]
  const index = Math.min(current, slides.length - 1)
  const slide = slides[index]

  const update = (patch: Partial<typeof slide>) => onChange({ slides: slides.map((s, i) => (i === index ? { ...s, ...patch } : s)) })
  const add = () => {
    onChange({ slides: [...slides.slice(0, index + 1), { title: '', body: '' }, ...slides.slice(index + 1)] })
    setCurrent(index + 1)
  }
  const remove = () => {
    if (slides.length === 1) return
    onChange({ slides: slides.filter((_, i) => i !== index) })
    setCurrent(Math.max(0, index - 1))
  }

  return (
    <div className="deck">
      <ol className="filmstrip" aria-label="Slides">
        {slides.map((s, i) => (
          <motion.li key={i} layout>
            <button className="film" data-active={i === index} onClick={() => setCurrent(i)}>
              <span className="film-num">{i + 1}</span>
              <span className="film-frame">
                <span className="film-title">{s.title || 'Untitled'}</span>
              </span>
            </button>
          </motion.li>
        ))}
        <li>
          <button className="film film-add" onClick={add} aria-label="Add slide">
            <Plus size={18} weight="bold" />
          </button>
        </li>
      </ol>
      <AnimatePresence mode="wait">
        <motion.section
          key={index}
          className="stage"
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
          transition={softSpring}
        >
          <input className="stage-title" value={slide.title} onChange={(e) => update({ title: e.target.value })} placeholder="Slide title" />
          <textarea className="stage-body" value={slide.body} onChange={(e) => update({ body: e.target.value })} placeholder="Points or notes. Lines starting with - become bullets" />
          <button className="icon-btn stage-remove" onClick={remove} disabled={slides.length === 1} aria-label="Delete slide" title="Delete slide">
            <Trash />
          </button>
        </motion.section>
      </AnimatePresence>
    </div>
  )
}

export default function Editor() {
  const { id } = useParams()
  const [doc, setDoc] = useState<Doc | null>(null)
  const [missing, setMissing] = useState(false)
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)

  // Backups run a few seconds after a save; refresh the Drive badge once they likely landed.
  const refreshMeta = useCallback(() => {
    if (!id) return
    window.setTimeout(() => {
      api.getDocument(id).then((d) => setDoc((cur) => (cur ? { ...cur, drive_url: d.drive_url, backup_error: d.backup_error, backed_up_at: d.backed_up_at } : cur)), () => {})
    }, 6000)
  }, [id])
  const { state, queue, flush } = useAutosave(id, google?.connected ? refreshMeta : noop)

  useEffect(() => {
    if (id) api.getDocument(id).then(setDoc, () => setMissing(true))
    api.googleStatus().then(setGoogle, () => setGoogle(null))
  }, [id])

  if (missing)
    return (
      <main className="editor">
        <div className="empty">
          <h2>This document has wandered off.</h2>
          <Link to="/" className="btn btn-ghost">
            <ArrowLeft /> Back to library
          </Link>
        </div>
      </main>
    )
  if (!doc) return <div className="boot" aria-busy="true" />

  const { icon: Icon } = KINDS[doc.kind]
  const setContent = (content: Doc['content']) => {
    setDoc({ ...doc, content } as Doc)
    queue({ content })
  }

  const actions: DocActions = {
    exportFile: async (format, background) => {
      await flush() // export what is on screen, not the last autosave
      await api.exportFile(doc.id, format, doc.title, background)
    },
    exportGoogle: google?.connected
      ? async () => {
          // Open the tab synchronously so pop-up blockers allow it, then point it at Drive.
          const tab = window.open('', '_blank')
          try {
            await flush()
            const { url } = await api.exportGoogle(doc.id)
            if (tab) tab.location.href = url
            else window.location.href = url
            setDoc((d) => (d ? { ...d, drive_url: url, backup_error: null } : d))
          } catch (err) {
            tab?.close()
            throw err
          }
        }
      : null,
  }

  return (
    <motion.main className="editor" data-kind={doc.kind} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={softSpring}>
      <header className="editor-bar" data-kind={doc.kind}>
        <div className="editor-top">
          <Link to="/" className="icon-btn" aria-label="Back to library" title="Back to library">
            <ArrowLeft />
          </Link>
          <span className="editor-kind" title={KINDS[doc.kind].label}>
            <Icon weight="fill" size={22} />
          </span>
          <div className="editor-heading">
            <input
              className="editor-title"
              value={doc.title}
              size={Math.max(4, doc.title.length)}
              onChange={(e) => {
                setDoc({ ...doc, title: e.target.value })
                queue({ title: e.target.value })
              }}
              aria-label="Title"
            />
            <AnimatePresence initial={false}>
              {(state !== 'idle' || doc.source === 'mcp' || google?.connected) && (
                <motion.div
                  key="status"
                  className="editor-status"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 18, opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 34 }}
                >
                  {doc.source === 'mcp' && (
                    <span className="badge" title="Created by an AI agent over MCP">
                      <Robot size={12} weight="fill" /> AI
                    </span>
                  )}
                  <SaveIndicator state={state} />
                  <DriveBadge google={google} doc={doc} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="editor-actions">
            {doc.kind === 'doc' && (
              <button type="button" className="icon-btn" aria-label="Print" title="Print (Ctrl+P)" onClick={() => window.print()}>
                <Printer />
              </button>
            )}
            <ExportMenu kind={doc.kind} actions={actions} />
          </div>
        </div>
        {doc.kind === 'doc' && <div className="editor-tools" ref={setToolbarHost} />}
      </header>
      <div className="editor-body">
        {doc.kind === 'doc' && <DocEditor body={doc.content} onChange={setContent} toolbarHost={toolbarHost} />}
        {doc.kind === 'sheet' && <SheetEditor body={doc.content} onChange={setContent} />}
        {doc.kind === 'slides' && <SlidesEditor body={doc.content} onChange={setContent} />}
      </div>
    </motion.main>
  )
}

function noop() {}
