import {
  ArrowsCounterClockwise,
  ArrowsLeftRight,
  BookOpen,
  CalendarDots,
  ChartBarHorizontal,
  ChartPie,
  Cube,
  Database,
  FlowArrow,
  Graph,
  Path,
  SquaresFour,
  TreeStructure,
  WarningCircle,
  X,
  type Icon,
} from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { renderDiagram, TEMPLATES, useMode, type Rendered } from '../lib/diagram'
import { Float } from './EditorUI'

const ICONS: Record<string, Icon> = {
  flowchart: FlowArrow,
  sequence: ArrowsLeftRight,
  mindmap: Graph,
  org: TreeStructure,
  timeline: CalendarDots,
  gantt: ChartBarHorizontal,
  pie: ChartPie,
  quadrant: SquaresFour,
  state: ArrowsCounterClockwise,
  journey: Path,
  er: Database,
  class: Cube,
}

const SYNTAX_GUIDE = 'https://mermaid.js.org/intro/syntax-reference.html'

export default function DiagramDialog({
  initial,
  editing,
  onClose,
  onSave,
}: {
  initial: string
  editing: boolean
  onClose: () => void
  /** Store the diagram; rejects with a message to show. */
  onSave: (code: string) => Promise<void>
}) {
  const mode = useMode()
  const [code, setCode] = useState(initial || TEMPLATES[0].code)
  const [picked, setPicked] = useState<string | null>(initial ? null : TEMPLATES[0].key)
  const [drawn, setDrawn] = useState<Rendered | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const text = useRef<HTMLTextAreaElement>(null)

  // Live preview, lightly debounced while typing.
  useEffect(() => {
    let live = true
    const t = window.setTimeout(() => {
      renderDiagram(code, mode).then(
        (r) => {
          if (!live) return
          setDrawn(r)
          setError(null)
        },
        (err: Error) => live && setError(err.message),
      )
    }, 220)
    return () => {
      live = false
      window.clearTimeout(t)
    }
  }, [code, mode])

  const save = async () => {
    if (error || saving || !code.trim()) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(code.trim())
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'The diagram could not be saved')
      setSaving(false)
    }
  }

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const onTextKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      void save()
    } else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault()
      const el = e.currentTarget
      const { selectionStart: a, selectionEnd: b } = el
      setCode(code.slice(0, a) + '  ' + code.slice(b))
      requestAnimationFrame(() => el.setSelectionRange(a + 2, a + 2))
    }
  }

  return (
    <Float>
      <motion.div className="dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={() => !saving && onClose()}>
        <motion.div
          className="dialog diagram-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="diagram-dialog-title"
          initial={{ opacity: 0, y: 18, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 12, scale: 0.98, transition: { duration: 0.15 } }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="dialog-head">
            <div>
              <h2 id="diagram-dialog-title">{editing ? 'Edit diagram' : 'Insert a diagram'}</h2>
              <p>Describe it in a few lines of text and Chia draws it in its own style, in light and dark.</p>
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="Close" title="Close" disabled={saving}>
              <X size={18} weight="bold" />
            </button>
          </header>

          <div className="diagram-body">
            <div className="diagram-side">
              <span className="diagram-label">Start from</span>
              <div className="diagram-templates" role="listbox" aria-label="Diagram templates">
                {TEMPLATES.map((t) => {
                  const I = ICONS[t.key] ?? FlowArrow
                  return (
                    <motion.button
                      key={t.key}
                      type="button"
                      role="option"
                      aria-selected={picked === t.key}
                      className="diagram-template"
                      data-active={picked === t.key || undefined}
                      title={t.hint}
                      whileTap={{ scale: 0.96 }}
                      onClick={() => {
                        setPicked(t.key)
                        setCode(t.code)
                        text.current?.focus()
                      }}
                    >
                      <I size={18} weight={picked === t.key ? 'fill' : 'regular'} />
                      <span>{t.label}</span>
                    </motion.button>
                  )
                })}
              </div>
              <label className="diagram-label" htmlFor="diagram-code">
                Diagram text
                <a href={SYNTAX_GUIDE} target="_blank" rel="noreferrer">
                  <BookOpen size={14} weight="bold" /> Syntax guide
                </a>
              </label>
              <textarea
                id="diagram-code"
                ref={text}
                className="diagram-code"
                value={code}
                spellCheck={false}
                autoFocus
                onChange={(e) => {
                  setCode(e.target.value)
                  setPicked(null)
                }}
                onKeyDown={onTextKey}
              />
              <p className="diagram-tip">
                Uses Mermaid, the diagram language Claude writes too: ask Claude for one and paste it here.
              </p>
            </div>

            <div className="diagram-preview" data-error={error ? true : undefined}>
              {drawn && <div className="diagram-svg" style={{ maxWidth: drawn.width }} dangerouslySetInnerHTML={{ __html: drawn.svg }} />}
              {!drawn && !error && <span className="spinner" />}
              {error && (
                <motion.div className="diagram-error" role="alert" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
                  <WarningCircle size={18} weight="fill" />
                  <span>{error}</span>
                </motion.div>
              )}
            </div>
          </div>

          <footer className="dialog-foot">
            {saveError && <p className="form-error">{saveError}</p>}
            <span className="dialog-keys">
              <kbd>Ctrl</kbd> <kbd>Enter</kbd> to {editing ? 'save' : 'insert'}
            </span>
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={save} disabled={!!error || saving || !code.trim()}>
              {saving ? 'Saving…' : editing ? 'Save changes' : 'Insert diagram'}
            </button>
          </footer>
        </motion.div>
      </motion.div>
    </Float>
  )
}
