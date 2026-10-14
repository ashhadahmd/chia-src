import { CheckCircle, CircleNotch, Leaf, MagnifyingGlass, UploadSimple, WarningCircle, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import DocCard from '../components/DocCard'
import ImportMenu from '../components/ImportMenu'
import NewMenu from '../components/NewMenu'
import Sidebar from '../components/Sidebar'
import { useFilter, type Filter } from '../lib/filter'
import { api, type DocKind, type DocSummary, type GoogleStatus, type ImportResult } from '../lib/api'
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

export default function Library() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [filter] = useFilter()
  const [docs, setDocs] = useState<DocSummary[] | null>(null)
  const [query, setQuery] = useState('')
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  const [task, setTask] = useState<ImportTask | null>(null)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const dismiss = useRef<number | undefined>(undefined)

  useEffect(() => {
    api.listDocuments().then(setDocs, () => setDocs([]))
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
    if (made.length) setDocs((d) => [...made, ...(d ?? []).filter((x) => !made.some((m) => m.id === x.id))])
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
    return (docs ?? []).filter(
      (d) =>
        (filter === 'all' || (filter === 'mcp' ? d.source === 'mcp' : d.kind === filter)) &&
        (!q || d.title.toLowerCase().includes(q)),
    )
  }, [docs, filter, query])

  async function remove(doc: DocSummary) {
    if (!window.confirm(`Delete “${doc.title}”? This cannot be undone.`)) return
    await api.deleteDocument(doc.id)
    setDocs((d) => (d ?? []).filter((x) => x.id !== doc.id))
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
          <ul className="grid">
            <AnimatePresence mode="popLayout">
              {visible.map((doc, i) => <DocCard key={doc.id} doc={doc} index={i} onDelete={remove} />)}
            </AnimatePresence>
          </ul>
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
