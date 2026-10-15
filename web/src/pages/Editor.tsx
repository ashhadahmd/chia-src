import { ArrowLeft, Check, CloudArrowUp, CloudCheck, CloudSlash, Eye, Plus, Printer, Robot, ShareNetwork, Trash, WarningCircle } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router'
import DocEditor from '../components/DocEditor'
import ExportMenu, { type DocActions } from '../components/ExportMenu'
import ShareDialog from '../components/ShareDialog'
import { api, ApiError, NetworkError, type Cell, type Doc, type DocSaved, type GoogleStatus, type SheetBody, type SlidesBody } from '../lib/api'
import { KINDS, softSpring } from '../lib/kinds'
import { local, type PendingSave } from '../lib/localStore'
import { claimDoc } from '../lib/outbox'
import { onChange, onResync, watchDocument } from '../lib/realtime'

type SyncState = 'idle' | 'local' | 'synced' | 'offline' | 'error'
type Patch = { title?: string; content?: Doc['content'] }

const SYNCED_SHOWN_MS = 2500 // "Synced" stays this long, then the status line folds away
const SAVE_DELAY_MS = 650
const MAX_RETRY_MS = 30_000

const isEmpty = (p: Patch) => Object.keys(p).length === 0

/** Local-first saving. Every edit lands in IndexedDB at once ("Saved locally"), then goes to the
    server after a pause. Each save names the revision it builds on; when someone (often an AI
    agent) saved in between, the server merges both and `onSaved` gets the merged content to
    show, unless more typing happened meanwhile: then the next save merges again. Failed or
    offline saves stay in the outbox and retry when the network returns. */
function useDocSync(id: string | undefined, onSaved: (saved: DocSaved, adopt: boolean) => void) {
  const [state, setState] = useState<SyncState>('idle')
  const base = useRef(0) // the stored revision what's on screen builds on
  const pending = useRef<Patch>({}) // not yet sent
  const inflight = useRef<Patch>({}) // sent, not yet confirmed
  const typing = useRef(false) // the doc editor has keystrokes it hasn't handed over yet
  const sending = useRef(false)
  const timer = useRef<number | undefined>(undefined)
  const hide = useRef<number | undefined>(undefined)
  const retries = useRef(0)
  const chain = useRef<Promise<void>>(Promise.resolve())
  const latest = useRef(onSaved)
  useEffect(() => {
    latest.current = onSaved
  })

  /** Everything unconfirmed goes to the outbox, so a reload or crash loses nothing. */
  const persist = useCallback(() => {
    if (!id) return
    const patch = { ...inflight.current, ...pending.current }
    if (isEmpty(patch)) void local.dropPending(id)
    else void local.putPending({ id, base_revision: base.current, patch, queued_at: Date.now() })
  }, [id])

  /** Send what is pending. Resolves to a delay after which to send again, or null. */
  const send = useCallback(async (): Promise<number | null> => {
    if (!id || sending.current || isEmpty(pending.current)) return null
    if (!navigator.onLine) {
      setState('offline')
      return null
    }
    const patch = pending.current
    pending.current = {}
    inflight.current = patch
    sending.current = true
    try {
      const saved = await api.updateDocument(id, { ...patch, base_revision: base.current })
      retries.current = 0
      inflight.current = {}
      sending.current = false
      if (isEmpty(pending.current) && !typing.current) {
        base.current = saved.revision
        persist()
        latest.current(saved, saved.merged)
        setState('synced')
        window.clearTimeout(hide.current)
        hide.current = window.setTimeout(() => setState((s) => (s === 'synced' ? 'idle' : s)), SYNCED_SHOWN_MS)
        return null
      } else {
        // More edits came in while this was on its way. Keep building on the old revision when
        // the server merged, so the next save merges again and keeps the other side's changes.
        if (!saved.merged) base.current = saved.revision
        persist()
        latest.current(saved, false)
        return SAVE_DELAY_MS
      }
    } catch (err) {
      sending.current = false
      pending.current = { ...patch, ...pending.current }
      inflight.current = {}
      const transient = err instanceof NetworkError || (err instanceof ApiError && (err.status >= 500 || err.status === 429))
      if (transient) {
        persist()
        setState(navigator.onLine ? 'local' : 'offline')
        return navigator.onLine ? Math.min(MAX_RETRY_MS, 2000 * 2 ** retries.current++) : null // `online` resumes
      } else {
        // Refused for good (no access any more, or deleted): stop retrying, keep the text on screen.
        pending.current = {}
        persist()
        setState('error')
        return null
      }
    }
  }, [id, persist])

  const flush = useCallback(
    function flushNow(): Promise<void> {
      window.clearTimeout(timer.current)
      chain.current = chain.current.then(send).then((again) => {
        if (again !== null) timer.current = window.setTimeout(() => void flushNow(), again)
      })
      return chain.current
    },
    [send],
  )

  const queue = useCallback(
    (patch: Patch) => {
      pending.current = { ...pending.current, ...patch }
      typing.current = false
      persist()
      window.clearTimeout(hide.current)
      setState(navigator.onLine ? 'local' : 'offline')
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => void flush(), SAVE_DELAY_MS)
    },
    [flush, persist],
  )

  /** Unsaved edits from an earlier visit (outbox) go out now. */
  const restore = useCallback(
    (save: PendingSave) => {
      base.current = save.base_revision
      pending.current = save.patch
      setState(navigator.onLine ? 'local' : 'offline')
      void flush()
    },
    [flush],
  )

  /** True when nothing local is waiting, so a newer stored version may replace the screen. */
  const idle = useCallback(() => !sending.current && !typing.current && isEmpty(pending.current) && isEmpty(inflight.current), [])
  const known = useCallback(() => base.current, [])
  const track = useCallback((rev: number) => {
    base.current = rev
  }, [])
  const markTyping = useCallback(() => {
    typing.current = true
  }, [])

  useEffect(() => {
    const online = () => void flush()
    const offline = () => setState((s) => (isEmpty(pending.current) && isEmpty(inflight.current) ? s : 'offline'))
    window.addEventListener('online', online)
    window.addEventListener('offline', offline)
    return () => {
      window.removeEventListener('online', online)
      window.removeEventListener('offline', offline)
    }
  }, [flush])
  useEffect(() => () => void flush(), [flush])
  useEffect(() => () => window.clearTimeout(hide.current), [])
  return { state, queue, flush, restore, idle, known, track, markTyping }
}

const REMOTE_SHOWN_MS = 5000

const SYNC_LABELS = {
  local: { icon: <CloudArrowUp size={14} weight="bold" />, text: 'Saved locally' },
  synced: { icon: <Check size={14} weight="bold" />, text: 'Synced' },
  offline: { icon: <CloudSlash size={14} weight="bold" />, text: 'Offline · saved on this device' },
  error: { icon: <WarningCircle size={14} weight="fill" />, text: 'Not saved' },
}

/** Stays mounted between states so only the icon and words change, not the whole line. */
function SaveIndicator({ state }: { state: SyncState }) {
  if (state === 'idle') return null
  const { icon, text } = SYNC_LABELS[state]
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

function SheetEditor({ body, onChange, readOnly }: { body: SheetBody; onChange: (b: SheetBody) => void; readOnly: boolean }) {
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
              <tr key={r}>
                <td className="sheet-rownum">{r + 1}</td>
                {row.map((cell, c) => (
                  <td key={c}>
                    <input
                      value={cell ?? ''}
                      readOnly={readOnly}
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
      {!readOnly && (
        <button className="btn btn-ghost" onClick={addRow}>
          <Plus size={16} weight="bold" /> Add row
        </button>
      )}
    </div>
  )
}

/** A short random id for a new slide, so edits to it can be matched up with other people's. */
const slideId = () => crypto.randomUUID().replace(/-/g, '').slice(0, 8)

function SlidesEditor({ body, onChange, readOnly }: { body: SlidesBody; onChange: (b: SlidesBody) => void; readOnly: boolean }) {
  const [current, setCurrent] = useState(0)
  const slides = body.slides.length ? body.slides : [{ id: 'first', title: '', body: '' }]
  const index = Math.min(current, slides.length - 1)
  const slide = slides[index]

  const update = (patch: Partial<typeof slide>) => onChange({ slides: slides.map((s, i) => (i === index ? { ...s, ...patch } : s)) })
  const add = () => {
    onChange({ slides: [...slides.slice(0, index + 1), { id: slideId(), title: '', body: '' }, ...slides.slice(index + 1)] })
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
          <motion.li key={s.id ?? i} layout>
            <button className="film" data-active={i === index} onClick={() => setCurrent(i)}>
              <span className="film-num">{i + 1}</span>
              <span className="film-frame">
                <span className="film-title">{s.title || 'Untitled'}</span>
              </span>
            </button>
          </motion.li>
        ))}
        {!readOnly && (
          <li>
            <button className="film film-add" onClick={add} aria-label="Add slide">
              <Plus size={18} weight="bold" />
            </button>
          </li>
        )}
      </ol>
      <AnimatePresence mode="wait">
        <motion.section
          key={slide.id ?? index}
          className="stage"
          initial={{ opacity: 0, scale: 0.97, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
          transition={softSpring}
        >
          <input className="stage-title" readOnly={readOnly} value={slide.title} onChange={(e) => update({ title: e.target.value })} placeholder="Slide title" />
          <textarea className="stage-body" readOnly={readOnly} value={slide.body} onChange={(e) => update({ body: e.target.value })} placeholder="Points or notes. Lines starting with - become bullets" />
          <button className="icon-btn stage-remove" onClick={remove} disabled={readOnly || slides.length === 1} aria-label="Delete slide" title="Delete slide">
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
  const [missing, setMissing] = useState<'gone' | 'offline' | null>(null)
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [toolbarHost, setToolbarHost] = useState<HTMLDivElement | null>(null)
  const [sharing, setSharing] = useState(false)
  const etag = useRef<string | null>(null)

  // Bumped when a newer version from elsewhere replaces what's on screen, so the doc editor reloads.
  const [sync, setSync] = useState(0)
  // "Updated by Codex" / "Merged with Codex's changes": shown briefly when that happens.
  const [remote, setRemote] = useState<string | null>(null)
  const remoteBy = useRef<string | null>(null) // the last other writer the change feed named
  const remoteTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(remoteTimer.current), [])
  const announce = useCallback((text: string) => {
    window.clearTimeout(remoteTimer.current)
    setRemote(text)
    remoteTimer.current = window.setTimeout(() => setRemote(null), REMOTE_SHOWN_MS)
  }, [])

  // Backups run a few seconds after a save; refresh the Drive badge once they likely landed.
  const refreshMeta = useCallback(() => {
    if (!id) return
    window.setTimeout(() => {
      api.getDocument(id).then((d) => setDoc((cur) => (cur ? { ...cur, drive_url: d.drive_url, backup_error: d.backup_error, backed_up_at: d.backed_up_at } : cur)), noop)
    }, 6000)
  }, [id])

  const onSaved = useCallback(
    (saved: DocSaved, adopt: boolean) => {
      setDoc((cur) => {
        if (!cur) return cur
        const next = { ...cur, revision: saved.revision, edited_by: saved.edited_by, updated_at: saved.updated_at } as Doc
        if (adopt && saved.content) next.content = saved.content
        void local.putDoc(next, null)
        return next
      })
      if (adopt && saved.content) {
        setSync((n) => n + 1)
        const who = remoteBy.current ?? 'another writer'
        announce(saved.conflicts.length ? `Merged with ${who}’s changes · kept both where you both edited` : `Merged with ${who}’s changes`)
      }
      if (google?.connected) refreshMeta()
    },
    [google?.connected, refreshMeta, announce],
  )
  const { state, queue, flush, restore, idle, known, track, markTyping } = useDocSync(id, onSaved)

  const load = useCallback(
    (d: Doc, tag: string | null) => {
      track(d.revision)
      etag.current = tag
      setDoc(d)
      void local.putDoc(d, tag)
    },
    [track],
  )

  /** Fetch the stored version if it changed (one conditional request) and show it, unless local
      edits are waiting: their save merges the change in instead. */
  const pullLatest = useCallback(() => {
    if (!id) return
    api.getDocumentIfChanged(id, etag.current).then((fresh) => {
      if (!fresh || fresh.data.revision <= known() || !idle()) return
      load(fresh.data, fresh.etag)
      setSync((n) => n + 1)
      announce(`Updated by ${fresh.data.edited_by ?? 'another window'}`)
    }, noop)
  }, [id, known, idle, load, announce])

  // Open: show the copy on this device at once, then check the server once in the background.
  useEffect(() => {
    if (!id) return
    let alive = true
    const release = claimDoc(id)
    watchDocument(id)
    void (async () => {
      const [cached, unsent] = await Promise.all([local.getDoc(id), local.getPending(id)])
      if (!alive) return
      if (cached) {
        track(cached.doc.revision)
        etag.current = cached.etag
        setDoc(cached.doc)
      }
      if (unsent) {
        restore(unsent) // its reply carries the latest version, merged with these edits
        if (cached) return
      }
      try {
        const fresh = await api.getDocumentIfChanged(id, cached ? cached.etag : null)
        if (!alive || !fresh) return
        if (!cached) load(fresh.data, fresh.etag)
        else if (fresh.data.revision > known() && idle()) {
          load(fresh.data, fresh.etag)
          setSync((n) => n + 1)
        }
      } catch (err) {
        if (alive && !cached) setMissing(err instanceof NetworkError ? 'offline' : 'gone')
      }
    })()
    api.googleStatus().then(setGoogle, () => setGoogle(null))
    return () => {
      alive = false
      release()
      watchDocument(null)
    }
  }, [id, load, track, restore, known, idle])

  // Changes pushed over the realtime feed; after a gap, reconcile once.
  useEffect(
    () =>
      onChange((e) => {
        if (e.doc_id !== id) return
        if (e.type === 'doc.deleted') {
          void local.deleteDoc(e.doc_id)
          setMissing('gone')
          return
        }
        if (e.edited_by) remoteBy.current = e.edited_by
        if (e.revision > known() && idle()) pullLatest()
      }),
    [id, known, idle, pullLatest],
  )
  useEffect(
    () =>
      onResync(() => {
        if (idle()) pullLatest()
        else void flush()
      }),
    [idle, pullLatest, flush],
  )

  if (missing)
    return (
      <main className="editor">
        <div className="empty">
          <h2>{missing === 'offline' ? 'You’re offline, and this document isn’t saved on this device yet.' : 'This document has wandered off.'}</h2>
          <Link to="/" className="btn btn-ghost">
            <ArrowLeft /> Back to library
          </Link>
        </div>
      </main>
    )
  if (!doc) return <div className="boot" aria-busy="true" />

  const { icon: Icon } = KINDS[doc.kind]
  const readOnly = doc.role === 'viewer'
  const canShare = doc.role === 'owner' || doc.role === 'admin'
  const edit = (patch: Patch) => {
    if (readOnly) return
    const next = { ...doc, ...patch } as Doc
    setDoc(next)
    queue(patch)
    void local.putDoc(next, null)
  }
  const setContent = (content: Doc['content']) => edit({ content })

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
              readOnly={readOnly}
              onChange={(e) => edit({ title: e.target.value })}
              aria-label="Title"
            />
            <AnimatePresence initial={false}>
              {(state !== 'idle' || remote || doc.edited_by || google?.connected) && (
                <motion.div
                  key="status"
                  className="editor-status"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 18, opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ type: 'spring', stiffness: 380, damping: 34 }}
                >
                  {readOnly && (
                    <span className="badge" title="You can read this document but not change it">
                      <Eye size={12} weight="fill" /> View only
                    </span>
                  )}
                  {doc.edited_by && !remote && (
                    <span className="badge" title={`Last changed by ${doc.edited_by} over MCP`}>
                      <Robot size={12} weight="fill" /> {doc.edited_by}
                    </span>
                  )}
                  {remote && (state === 'idle' || state === 'synced') ? (
                    <span className="save-state" data-state="remote" role="status">
                      <Robot size={14} weight="fill" />
                      {remote}
                    </span>
                  ) : (
                    <SaveIndicator state={state} />
                  )}
                  <DriveBadge google={google} doc={doc} />
                </motion.div>
              )}
            </AnimatePresence>
          </div>
          <div className="editor-actions">
            {canShare && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSharing(true)} title="Share this document with someone">
                <ShareNetwork size={16} weight="bold" /> Share
              </button>
            )}
            {doc.kind === 'doc' && (
              <button type="button" className="icon-btn" aria-label="Print" title="Print (Ctrl+P)" onClick={() => window.print()}>
                <Printer />
              </button>
            )}
            <ExportMenu kind={doc.kind} actions={actions} />
          </div>
        </div>
        {doc.kind === 'doc' && !readOnly && <div className="editor-tools" ref={setToolbarHost} />}
      </header>
      <div className="editor-body">
        {doc.kind === 'doc' && (
          <DocEditor body={doc.content} onChange={setContent} onTyping={markTyping} toolbarHost={readOnly ? null : toolbarHost} sync={sync} readOnly={readOnly} />
        )}
        {doc.kind === 'sheet' && <SheetEditor body={doc.content} onChange={setContent} readOnly={readOnly} />}
        {doc.kind === 'slides' && <SlidesEditor body={doc.content} onChange={setContent} readOnly={readOnly} />}
      </div>
      <AnimatePresence>{sharing && <ShareDialog docId={doc.id} title={doc.title} onClose={() => setSharing(false)} />}</AnimatePresence>
    </motion.main>
  )
}

function noop() {}
