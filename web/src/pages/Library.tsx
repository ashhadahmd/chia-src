import { CheckCircle, CircleNotch, Leaf, ListBullets, MagnifyingGlass, SquaresFour, UploadSimple, WarningCircle, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import DocCard, { DocRow } from '../components/DocCard'
import { Select } from '../components/EditorUI'
import ImportMenu from '../components/ImportMenu'
import NewMenu from '../components/NewMenu'
import Sidebar from '../components/Sidebar'
import { useFilter, type Filter } from '../lib/filter'
import { api, parseDate, type DocKind, type DocSummary, type GoogleStatus, type ImportResult } from '../lib/api'
import { local } from '../lib/localStore'
import { onChange, onResync } from '../lib/realtime'
import { useWorkspaces } from '../lib/workspaces'
import { pickFromDrive } from '../lib/picker'
import { useAuth } from '../lib/useAuth'
import { KINDS, softSpring } from '../lib/kinds'

function greeting(): string {
  const h = new Date().getHours()
  return h < 5 ? 'Good evening' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
}

const EMPTY_COPY: Record<Filter, string> = {
  all: 'Nothing planted yet.',
  doc: 'No docs yet.',
  sheet: 'No sheets yet.',
  slides: 'No decks yet.',
  mcp: 'No AI-made documents yet.',
}

type View = 'grid' | 'list'
type Sort = 'modified' | 'name'
const VIEW_KEY = 'chia.library.view'
const SORT_KEY = 'chia.library.sort'

const SORTS: { value: Sort; label: string; hint: string }[] = [
  { value: 'modified', label: 'Last modified', hint: 'Most recently edited first' },
  { value: 'name', label: 'Name', hint: 'Alphabetical, A to Z' },
]
const byName = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null
    return value && allowed.includes(value) ? value : fallback
  } catch {
    return fallback // storage unavailable
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* storage unavailable */
  }
}

function ViewToggle({ view, onChange }: { view: View; onChange: (v: View) => void }) {
  const options = [
    { value: 'grid' as const, icon: SquaresFour, label: 'Grid view' },
    { value: 'list' as const, icon: ListBullets, label: 'List view' },
  ]
  return (
    <div className="view-toggle" role="radiogroup" aria-label="Layout">
      {options.map(({ value, icon: Icon, label }) => (
        <button key={value} type="button" role="radio" aria-checked={view === value} aria-label={label} title={label} onClick={() => onChange(value)}>
          {view === value && <motion.span layoutId="view-toggle-active" className="view-toggle-active" transition={softSpring} />}
          <Icon size={18} weight={view === value ? 'fill' : 'regular'} />
        </button>
      ))}
    </div>
  )
}

interface ImportTask {
  state: 'busy' | 'done' | 'error'
  text: string
  details: string[]
  open?: DocSummary
}

function ImportToast({ task, onClose }: { task: ImportTask; onClose: () => void }) {
  const icon = {
    busy: <CircleNotch size={20} className="spin" />,
    done: <CheckCircle size={20} weight="fill" />,
    error: <WarningCircle size={20} weight="fill" />,
  }[task.state]
  return (
    <motion.div
      className="toast"
      data-state={task.state}
      role="status"
      initial={{ opacity: 0, y: 24, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 16, scale: 0.97, transition: { duration: 0.15 } }}
      transition={softSpring}
    >
      <span className="toast-icon">{icon}</span>
      <div className="toast-body">
        <p className="toast-text">{task.text}</p>
        {task.details.length > 0 && (
          <ul className="toast-details">
            {task.details.map((d, i) => <li key={i}>{d}</li>)}
          </ul>
        )}
      </div>
      {task.open && (
        <Link className="btn btn-ghost btn-sm" to={`/d/${task.open.id}`}>
          Open
        </Link>
      )}
      {task.state !== 'busy' && (
        <button className="icon-btn" onClick={onClose} aria-label="Dismiss" title="Dismiss">
          <X size={16} />
        </button>
      )}
    </motion.div>
  )
}

/** The library for the current workspace: the copy on this device at once, then one conditional
    request (304 when nothing changed); after that, changes arrive over the realtime feed. */
function useLibrary() {
  const { key, isPersonal } = useWorkspaces()
  // Listings belong to a workspace; switching shows nothing until that one's list is in.
  const [state, setState] = useState<{ key: string; docs: DocSummary[] | null }>({ key, docs: null })
  const docs = state.key === key ? state.docs : null
  const etag = useRef<string | null>(null)
  const current = useRef(key)

  /** Change the shown list for workspace `k` and keep the device copy in step (`tag` null:
      changed locally or by an event, so the next reconcile fetches in full). */
  const put = useCallback((k: string, fn: (d: DocSummary[] | null) => DocSummary[] | null, tag: string | null = null) => {
    setState((prev) => {
      const next = fn(prev.key === k ? prev.docs : null)
      if (next) void local.putList(k, next, tag)
      return { key: k, docs: next }
    })
    if (current.current === k) etag.current = tag
  }, [])

  const reconcile = useCallback(() => {
    const k = current.current
    api.listDocumentsIfChanged(etag.current, isPersonal).then(
      (fresh) => {
        if (fresh && current.current === k) put(k, () => fresh.data, fresh.etag)
      },
      () => put(k, (d) => d ?? [], etag.current), // offline with nothing cached: an empty library
    )
  }, [isPersonal, put])

  useEffect(() => {
    current.current = key
    etag.current = null
    let alive = true
    void local.getList(key).then((cached) => {
      if (!alive) return
      if (cached) put(key, () => cached.docs, cached.etag)
      reconcile()
    })
    return () => {
      alive = false
    }
  }, [key, reconcile, put])

  useEffect(
    () =>
      onChange((e) =>
        put(current.current, (list) => {
          if (!list) return list
          const rest = list.filter((d) => d.id !== e.doc_id)
          return e.type === 'doc.deleted' || !e.doc ? rest : [e.doc, ...rest]
        }),
      ),
    [put],
  )
  useEffect(() => onResync(reconcile), [reconcile])

  const update = useCallback((fn: (d: DocSummary[]) => DocSummary[]) => put(current.current, (d) => fn(d ?? [])), [put])
  return { docs, update }
}

export default function Library() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [filter] = useFilter()
  const { docs, update: setDocs } = useLibrary()
  const [query, setQuery] = useState('')
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [task, setTask] = useState<ImportTask | null>(null)
  const [dragging, setDragging] = useState(false)
  const [view, setView] = useState<View>(() => stored(VIEW_KEY, ['grid', 'list'], 'grid'))
  const [sort, setSort] = useState<Sort>(() => stored(SORT_KEY, ['modified', 'name'], 'modified'))
  const dragDepth = useRef(0)
  const dismiss = useRef<number | undefined>(undefined)

  useEffect(() => {
    api.googleStatus().then(setGoogle, () => setGoogle(null))
    return () => window.clearTimeout(dismiss.current)
  }, [])

  /** Runs import jobs one by one; opens the document when exactly one came in cleanly. */
  async function runImport(label: string, jobs: { name: string; run: () => Promise<ImportResult> }[]) {
    window.clearTimeout(dismiss.current)
    setTask({ state: 'busy', text: `Importing ${label}…`, details: [] })
    const made: DocSummary[] = []
    const details: string[] = []
    let failed = 0
    for (const job of jobs) {
      try {
        const result = await job.run()
        made.push(...result.documents)
        details.push(...result.notes.map((n) => (jobs.length > 1 ? `${job.name}: ${n}` : n)))
      } catch (err) {
        failed++
        const message = err instanceof Error ? err.message : 'Import failed'
        details.push(jobs.length > 1 ? `${job.name}: ${message}` : message)
      }
    }
    if (made.length) setDocs((d) => [...made, ...d.filter((x) => !made.some((m) => m.id === x.id))])
    if (made.length === 1 && !failed && !details.length) {
      setTask(null)
      navigate(`/d/${made[0].id}`)
      return
    }
    const titles = made.length === 1 ? `“${made[0].title}”` : `${made.length} documents`
    setTask({
      state: made.length ? 'done' : 'error',
      text: made.length ? `Imported ${titles}${failed ? `, ${failed} failed` : ''}` : `Couldn’t import ${label}`,
      details,
      open: made.length === 1 ? made[0] : undefined,
    })
    dismiss.current = window.setTimeout(() => setTask(null), made.length && !failed ? 9000 : 14000)
  }

  const importFiles = (files: File[]) =>
    runImport(
      files.length === 1 ? `“${files[0].name}”` : `${files.length} files`,
      files.map((f) => ({ name: f.name, run: () => api.importFile(f) })),
    )

  const importLink = (url: string) => runImport('from Google', [{ name: url, run: () => api.importGoogle({ url }) }])

  async function importDrive() {
    try {
      const ids = await pickFromDrive(await api.googlePicker())
      if (ids.length)
        await runImport(
          ids.length === 1 ? 'from Drive' : `${ids.length} Drive files`,
          ids.map((id, i) => ({ name: `Drive file ${i + 1}`, run: () => api.importGoogle({ file_id: id }) })),
        )
    } catch (err) {
      setTask({ state: 'error', text: 'Couldn’t open Google Drive', details: [err instanceof Error ? err.message : String(err)] })
    }
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')
  const dropHandlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current++
      setDragging(true)
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragging(false)
      const files = Array.from(e.dataTransfer.files)
      if (files.length) importFiles(files)
    },
  }

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, doc: 0, sheet: 0, slides: 0, mcp: 0 }
    for (const d of docs ?? []) {
      c.all++
      c[d.kind]++
      if (d.source === 'mcp') c.mcp++
    }
    return c
  }, [docs])

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const shown = (docs ?? []).filter(
      (d) =>
        (filter === 'all' || (filter === 'mcp' ? d.source === 'mcp' : d.kind === filter)) &&
        (!q || d.title.toLowerCase().includes(q)),
    )
    return sort === 'name'
      ? shown.sort((a, b) => byName.compare(a.title.trim(), b.title.trim()))
      : shown.sort((a, b) => parseDate(b.updated_at).getTime() - parseDate(a.updated_at).getTime())
  }, [docs, filter, query, sort])

  async function remove(doc: DocSummary) {
    if (!window.confirm(`Delete “${doc.title}”? This cannot be undone.`)) return
    await api.deleteDocument(doc.id)
    void local.deleteDoc(doc.id)
    setDocs((d) => d.filter((x) => x.id !== doc.id))
  }

  async function create(kind: DocKind) {
    const doc = await api.createDocument(kind, `Untitled ${KINDS[kind].label.toLowerCase()}`)
    navigate(`/d/${doc.id}`)
  }

  const heading = filter === 'all' ? `${greeting()}, ${user?.username}` : filter === 'mcp' ? 'Made by AI' : KINDS[filter].plural

  return (
    <div className="shell">
      <Sidebar counts={counts} />
      <main className="library" {...dropHandlers}>
        <header className="library-head">
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1
              key={heading}
              className="library-title"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8, transition: { duration: 0.12 } }}
            >
              {heading}
            </motion.h1>
          </AnimatePresence>
          <div className="library-actions">
            <label className="search">
              <MagnifyingGlass size={18} />
              <input
                type="search"
                placeholder="Search titles"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search documents"
              />
            </label>
            <ImportMenu onFiles={importFiles} onLink={importLink} onDrive={google?.picker ? importDrive : undefined} canConnectGoogle={!!google?.configured && !google.connected} />
            <NewMenu onCreate={create} />
          </div>
        </header>

        <div className="library-bar">
          <span className="library-count">
            {docs === null ? '\u00a0' : `${visible.length} ${visible.length === 1 ? 'item' : 'items'}`}
          </span>
          <Select
            className="library-select"
            label="Sort by"
            tip={{ label: 'Sort', hint: 'Order by last edit or by name' }}
            value={sort}
            choices={SORTS}
            onChange={(v) => {
              setSort(v)
              remember(SORT_KEY, v)
            }}
          />
          <ViewToggle
            view={view}
            onChange={(v) => {
              setView(v)
              remember(VIEW_KEY, v)
            }}
          />
        </div>

        {docs === null ? (
          <ul className="grid">
            {Array.from({ length: 6 }, (_, i) => <li key={i} className="card skeleton" />)}
          </ul>
        ) : visible.length === 0 ? (
          <motion.div className="empty" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <span className="empty-mark">
              <Leaf size={30} weight="fill" />
            </span>
            <h2>{query ? 'Nothing matches that search.' : EMPTY_COPY[filter]}</h2>
            <p>
              {filter === 'mcp'
                ? 'Connect a local AI agent to Chia’s MCP endpoint and its documents will grow here.'
                : 'Start a doc, sheet or deck with New, bring in Word, Excel or PowerPoint files with Import, or let a connected AI draft one for you.'}
            </p>
          </motion.div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={view}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.12 } }}
              transition={softSpring}
            >
              {view === 'grid' ? (
                <ul className="grid">
                  <AnimatePresence mode="popLayout">
                    {visible.map((doc, i) => <DocCard key={doc.id} doc={doc} index={i} onDelete={remove} />)}
                  </AnimatePresence>
                </ul>
              ) : (
                <div className="doc-table">
                  <div className="doc-table-head" aria-hidden="true">
                    <span>Name</span>
                    <span>Type</span>
                    <span>Last modified</span>
                  </div>
                  <ul className="doc-list">
                    <AnimatePresence mode="popLayout">
                      {visible.map((doc, i) => <DocRow key={doc.id} doc={doc} index={i} onDelete={remove} />)}
                    </AnimatePresence>
                  </ul>
                </div>
              )}
            </motion.div>
          </AnimatePresence>
        )}
        <AnimatePresence>
          {dragging && (
            <motion.div className="drop-zone" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} aria-hidden="true">
              <motion.div className="drop-card" initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96 }} transition={softSpring}>
                <span className="empty-mark">
                  <UploadSimple size={30} weight="bold" />
                </span>
                <h2>Drop to import</h2>
                <p>Word, Excel, PowerPoint, CSV or Markdown</p>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
        <AnimatePresence>{task && <ImportToast key="toast" task={task} onClose={() => setTask(null)} />}</AnimatePresence>
      </main>
    </div>
  )
}
