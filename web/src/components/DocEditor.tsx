import {
  ArrowClockwise,
  ArrowCounterClockwise,
  CaretDown,
  Copy,
  DownloadSimple,
  Eraser,
  FileDoc,
  FilePdf,
  GoogleLogo,
  LinkSimple,
  Minus,
  Plus,
  Printer,
  Scissors,
  TextAlignCenter,
  TextAlignJustify,
  TextAlignLeft,
  TextAlignRight,
  TextB,
  TextItalic,
  TextUnderline,
  type Icon,
} from '@phosphor-icons/react'
import { TextAlign } from '@tiptap/extension-text-align'
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { Placeholder } from '@tiptap/extensions'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PAGE_SIZES, PaginationPlus } from 'tiptap-pagination-plus'
import type { DocBody, PageSize } from '../lib/api'
import { findPassage, makePassage, parsePassage, passageHash, passageKey, PassageHighlight } from '../lib/passage'
import { applyTheme } from '../lib/theme'
import { scrollToPos } from '../lib/scroll'
import DocOutline from './DocOutline'

const PAGES: Record<PageSize, { label: string; size: typeof PAGE_SIZES.LETTER; css: string }> = {
  letter: { label: 'Letter', size: PAGE_SIZES.LETTER, css: 'letter' },
  a4: { label: 'A4', size: PAGE_SIZES.A4, css: 'A4' },
}
const BLOCKS = [
  { value: 'p', label: 'Normal text' },
  { value: '1', label: 'Heading 1' },
  { value: '2', label: 'Heading 2' },
  { value: '3', label: 'Heading 3' },
]
const OUTLINE_KEY = 'chia.outline'
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48]
const DEFAULT_SIZE = 11

interface Tip {
  label: string
  hint?: string
  keys?: string
}

const ALIGNS: { value: string; icon: Icon; tip: Tip }[] = [
  { value: 'left', icon: TextAlignLeft, tip: { label: 'Align left', hint: 'Line text up along the left edge', keys: 'Ctrl+Shift+L' } },
  { value: 'center', icon: TextAlignCenter, tip: { label: 'Centre', hint: 'Centre text on the page', keys: 'Ctrl+Shift+E' } },
  { value: 'right', icon: TextAlignRight, tip: { label: 'Align right', hint: 'Line text up along the right edge', keys: 'Ctrl+Shift+R' } },
  { value: 'justify', icon: TextAlignJustify, tip: { label: 'Justify', hint: 'Spread lines evenly to both edges', keys: 'Ctrl+Shift+J' } },
]

// Stored as `var(--tc-name, #lightHex)`: the editor adapts the colour to its theme and exports
// fall back to the hex. Keep in sync with TEXT_COLORS in api/app/export.py.
const TEXT_COLORS: { name: string; label: string; hex: string }[] = [
  { name: 'stone', label: 'Stone', hex: '#6F6E66' },
  { name: 'sage', label: 'Sage', hex: '#5A6B47' },
  { name: 'eucalyptus', label: 'Eucalyptus', hex: '#3F6E66' },
  { name: 'terracotta', label: 'Terracotta', hex: '#B05A47' },
  { name: 'ochre', label: 'Ochre', hex: '#9A7424' },
  { name: 'clay', label: 'Clay', hex: '#8C5A3C' },
  { name: 'plum', label: 'Plum', hex: '#7A4F72' },
  { name: 'slate', label: 'Slate', hex: '#4A5A6E' },
]
const colorValue = (c: (typeof TEXT_COLORS)[number]) => `var(--tc-${c.name}, ${c.hex})`

const PDF_BACKGROUNDS = [
  { value: '#F7F4ED', label: 'Oat paper' },
  { value: '#FFFFFF', label: 'White' },
  { value: '#EFE6D6', label: 'Sand' },
  { value: '#E6EBDF', label: 'Sage mist' },
  { value: '#1A1916', label: 'Espresso' },
]

export interface DocActions {
  exportFile: (format: 'pdf' | 'docx', background?: string) => Promise<void>
  exportGoogle: (() => Promise<void>) | null // null when Google is not connected
}

/* ───────────── Formatting state ───────────── */

function useFormat(editor: Editor) {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const style = e.getAttributes('textStyle')
      const raw = style.fontSize as string | undefined
      return {
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        size: raw ? Math.round(parseFloat(raw)) : DEFAULT_SIZE,
        color: (style.color as string | undefined) ?? null,
        align: ALIGNS.find((a) => a.value !== 'left' && e.isActive({ textAlign: a.value }))?.value ?? 'left',
        block: BLOCKS.find((b) => b.value !== 'p' && e.isActive('heading', { level: Number(b.value) }))?.value ?? 'p',
        empty: e.state.selection.empty,
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
      }
    },
  })
}

function setSize(editor: Editor, size: number) {
  const chain = editor.chain().focus()
  if (size === DEFAULT_SIZE) chain.unsetFontSize().run()
  else chain.setFontSize(`${size}pt`).run()
}

function stepSize(editor: Editor, current: number, dir: 1 | -1) {
  const next = dir > 0 ? SIZES.find((s) => s > current) : [...SIZES].reverse().find((s) => s < current)
  if (next) setSize(editor, next)
}

/* ───────────── Floating layer (tooltips, popovers) ───────────── */

/** Renders into <body> so toolbar overflow never clips it. */
function Float({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}

function useTooltip(tip: Tip | undefined) {
  const [rect, setRect] = useState<DOMRect | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const show = (el: HTMLElement) => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setRect(el.getBoundingClientRect()), 380)
  }
  const hide = () => {
    window.clearTimeout(timer.current)
    setRect(null)
  }
  const bind = {
    onMouseEnter: (e: ReactMouseEvent<HTMLElement>) => show(e.currentTarget),
    onMouseLeave: hide,
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) show(e.currentTarget)
    },
    onBlur: hide,
    onMouseDown: hide,
  }
  const node =
    tip && rect ? (
      <Float>
        <motion.div
          className="tooltip"
          role="tooltip"
          style={{ left: Math.max(90, Math.min(rect.left + rect.width / 2, window.innerWidth - 90)), top: rect.bottom + 8 }}
          initial={{ opacity: 0, y: -3, x: '-50%' }}
          animate={{ opacity: 1, y: 0, x: '-50%' }}
          transition={{ duration: 0.14, ease: 'easeOut' }}
        >
          <span className="tooltip-head">
            <span className="tooltip-label">{tip.label}</span>
            {tip.keys && <kbd>{tip.keys}</kbd>}
          </span>
          {tip.hint && <span className="tooltip-hint">{tip.hint}</span>}
        </motion.div>
      </Float>
    ) : null
  return { bind, node }
}

function Tool({ icon: I, tip, active, disabled, onClick }: { icon: Icon; tip: Tip; active?: boolean; disabled?: boolean; onClick: () => void }) {
  const { bind, node } = useTooltip(tip)
  return (
    <>
      <button
        type="button"
        className="tool"
        data-active={active || undefined}
        disabled={disabled}
        aria-label={tip.label}
        aria-pressed={active}
        {...bind}
        onMouseDown={(e) => {
          e.preventDefault() // keep the text selection
          bind.onMouseDown()
        }}
        onClick={onClick}
      >
        <I size={18} weight={active ? 'bold' : 'regular'} />
      </button>
      {node}
    </>
  )
}

function Popover({
  trigger,
  children,
  align = 'left',
}: {
  trigger: (open: boolean, toggle: (el: HTMLElement) => void) => ReactNode
  children: (close: () => void) => ReactNode
  align?: 'left' | 'right'
}) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!anchor) return
    const close = () => setAnchor(null)
    const onDown = (e: MouseEvent) => {
      if (!panel.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [anchor])

  return (
    <>
      {trigger(anchor !== null, (el) => setAnchor((a) => (a ? null : el.getBoundingClientRect())))}
      <Float>
        <AnimatePresence>
          {anchor && (
            <motion.div
              ref={panel}
              className="popover float-panel"
              style={
                align === 'right'
                  ? { top: anchor.bottom + 8, right: window.innerWidth - anchor.right, transformOrigin: 'top right' }
                  : { top: anchor.bottom + 8, left: anchor.left, transformOrigin: 'top left' }
              }
              initial={{ opacity: 0, y: -6, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.97, transition: { duration: 0.1 } }}
            >
              {children(() => setAnchor(null))}
            </motion.div>
          )}
        </AnimatePresence>
      </Float>
    </>
  )
}

/* ───────────── Controls ───────────── */

function SizeStepper({ editor, size }: { editor: Editor; size: number }) {
  const { bind, node } = useTooltip({ label: 'Font size', hint: 'Pick an exact size in points' })
  return (
    <div className="size-stepper" role="group" aria-label="Font size">
      <Tool icon={Minus} tip={{ label: 'Smaller text', hint: 'Step the font size down' }} disabled={size <= SIZES[0]} onClick={() => stepSize(editor, size, -1)} />
      <label className="size-value" {...bind}>
        <select value={SIZES.includes(size) ? size : DEFAULT_SIZE} onChange={(e) => setSize(editor, Number(e.target.value))} aria-label="Font size">
          {SIZES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      {node}
      <Tool icon={Plus} tip={{ label: 'Larger text', hint: 'Step the font size up' }} disabled={size >= SIZES.at(-1)!} onClick={() => stepSize(editor, size, 1)} />
    </div>
  )
}

function ColorTool({ editor, color }: { editor: Editor; color: string | null }) {
  const { bind, node } = useTooltip({ label: 'Text colour', hint: 'Colour the selected text' })
  const pick = (value: string | null, close: () => void) => {
    if (value) editor.chain().focus().setColor(value).run()
    else editor.chain().focus().unsetColor().run()
    close()
  }
  return (
    <Popover
      trigger={(open, toggle) => (
        <>
          <button
            type="button"
            className="tool tool-color"
            data-active={open || undefined}
            aria-label="Text colour"
            aria-expanded={open}
            {...bind}
            onMouseDown={(e) => {
              e.preventDefault()
              bind.onMouseDown()
            }}
            onClick={(e) => toggle(e.currentTarget)}
          >
            <span className="tool-color-a">A</span>
            <span className="tool-color-bar" style={{ background: color ?? 'var(--ink)' }} />
          </button>
          {node}
        </>
      )}
    >
      {(close) => (
        <div className="swatches" role="listbox" aria-label="Text colour">
          <button
            className="swatch swatch-default"
            role="option"
            aria-selected={!color}
            aria-label="Default colour"
            title="Default"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => pick(null, close)}
          />
          {TEXT_COLORS.map((c) => (
            <button
              key={c.name}
              className="swatch"
              role="option"
              aria-selected={color === colorValue(c)}
              aria-label={c.label}
              title={c.label}
              style={{ background: `var(--tc-${c.name})` }}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(colorValue(c), close)}
            />
          ))}
        </div>
      )}
    </Popover>
  )
}

function ExportMenu({ actions }: { actions: DocActions }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { bind, node } = useTooltip({ label: 'Export', hint: 'Download as PDF or Word, or open in Google Docs' })
  const run = async (key: string, fn: () => Promise<void>, close: () => void) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(null)
    }
  }
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <>
          <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} {...bind} onClick={(e) => toggle(e.currentTarget)}>
            <DownloadSimple size={16} weight="bold" /> Export <CaretDown size={12} weight="bold" />
          </button>
          {node}
        </>
      )}
    >
      {(close) => (
        <div className="export-menu">
          <div className="export-group">
            <span className="export-title">
              <FilePdf size={18} weight="fill" /> PDF
            </span>
            <span className="export-hint">Pick a page colour</span>
            <div className="export-swatches">
              {PDF_BACKGROUNDS.map((bg) => (
                <button
                  key={bg.value}
                  className="export-swatch"
                  style={{ background: bg.value }}
                  title={bg.label}
                  aria-label={`PDF on ${bg.label}`}
                  disabled={busy !== null}
                  data-busy={busy === bg.value || undefined}
                  onClick={() => run(bg.value, () => actions.exportFile('pdf', bg.value), close)}
                />
              ))}
            </div>
          </div>
          <button className="popover-item" disabled={busy !== null} onClick={() => run('docx', () => actions.exportFile('docx'), close)}>
            <span className="popover-icon export-icon">
              <FileDoc weight="fill" />
            </span>
            <span>
              <span className="popover-label">Word document</span>
              <span className="popover-hint">.docx for Microsoft Word</span>
            </span>
          </button>
          <button
            className="popover-item"
            disabled={busy !== null || !actions.exportGoogle}
            onClick={() => actions.exportGoogle && run('google', actions.exportGoogle, close)}
          >
            <span className="popover-icon export-icon">
              <GoogleLogo weight="bold" />
            </span>
            <span>
              <span className="popover-label">Google Docs</span>
              <span className="popover-hint">{actions.exportGoogle ? 'Opens your Drive copy' : 'Connect Google to enable'}</span>
            </span>
          </button>
          {busy && <p className="export-status">Preparing…</p>}
          {error && <p className="form-error export-status">{error}</p>}
        </div>
      )}
    </Popover>
  )
}

/* ───────────── Toolbar (rendered inside the editor's top bar) ───────────── */

interface ToolbarProps {
  editor: Editor
  page: PageSize
  onPage: (p: PageSize) => void
  actions: DocActions
  onCopyLink: () => void
}

function Toolbar({ editor, page, onPage, actions, onCopyLink }: ToolbarProps) {
  const f = useFormat(editor)
  const c = () => editor.chain().focus()
  const pageTip = useTooltip({ label: 'Page size', hint: 'Paper size used for printing and export' })
  const styleTip = useTooltip({ label: 'Style', hint: 'Normal text or a heading. Headings build the outline', keys: 'Ctrl+Alt+1–3' })
  const setBlock = (value: string) =>
    value === 'p' ? c().setParagraph().run() : c().setHeading({ level: Number(value) as 1 | 2 | 3 }).run()
  return (
    <div className="doc-toolbar" role="toolbar" aria-label="Formatting">
      <Tool icon={ArrowCounterClockwise} tip={{ label: 'Undo', hint: 'Reverse your last change', keys: 'Ctrl+Z' }} disabled={!f.canUndo} onClick={() => c().undo().run()} />
      <Tool icon={ArrowClockwise} tip={{ label: 'Redo', hint: 'Bring back what you undid', keys: 'Ctrl+Shift+Z' }} disabled={!f.canRedo} onClick={() => c().redo().run()} />
      <span className="tool-divider" />
      <label className="page-select style-select" {...styleTip.bind}>
        <select value={f.block} onChange={(e) => setBlock(e.target.value)} aria-label="Style">
          {BLOCKS.map((b) => (
            <option key={b.value} value={b.value}>
              {b.label}
            </option>
          ))}
        </select>
        <CaretDown size={12} weight="bold" />
      </label>
      {styleTip.node}
      <SizeStepper editor={editor} size={f.size} />
      <span className="tool-divider" />
      <Tool icon={TextB} tip={{ label: 'Bold', hint: 'Make text heavier', keys: 'Ctrl+B' }} active={f.bold} onClick={() => c().toggleBold().run()} />
      <Tool icon={TextItalic} tip={{ label: 'Italic', hint: 'Slant text for emphasis', keys: 'Ctrl+I' }} active={f.italic} onClick={() => c().toggleItalic().run()} />
      <Tool icon={TextUnderline} tip={{ label: 'Underline', hint: 'Draw a line under text', keys: 'Ctrl+U' }} active={f.underline} onClick={() => c().toggleUnderline().run()} />
      <ColorTool editor={editor} color={f.color} />
      <Tool icon={LinkSimple} tip={{ label: 'Link to selection', hint: 'Copy a link that opens this doc right at the selected text' }} disabled={f.empty} onClick={onCopyLink} />
      <span className="tool-divider" />
      {ALIGNS.map((a) => (
        <Tool key={a.value} icon={a.icon} tip={a.tip} active={f.align === a.value} onClick={() => c().setTextAlign(a.value).run()} />
      ))}
      <span className="tool-divider" />
      <label className="page-select" {...pageTip.bind}>
        <select value={page} onChange={(e) => onPage(e.target.value as PageSize)} aria-label="Page size">
          {(Object.keys(PAGES) as PageSize[]).map((k) => (
            <option key={k} value={k}>
              {PAGES[k].label}
            </option>
          ))}
        </select>
        <CaretDown size={12} weight="bold" />
      </label>
      {pageTip.node}
      <span className="tool-spacer" />
      <Tool icon={Printer} tip={{ label: 'Print', hint: 'Print this document', keys: 'Ctrl+P' }} onClick={() => window.print()} />
      <ExportMenu actions={actions} />
    </div>
  )
}

/* ───────────── Right-click format menu ───────────── */

function ContextMenu({ editor, at, onClose, onCopyLink }: { editor: Editor; at: { x: number; y: number }; onClose: () => void; onCopyLink: () => void }) {
  const f = useFormat(editor)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(at)
  const c = () => editor.chain().focus()

  // Keep the menu fully on screen.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    setPos({ x: Math.min(at.x, window.innerWidth - width - 12), y: Math.min(at.y, window.innerHeight - height - 12) })
  }, [at])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      // Clicks inside the menu or its colour popover keep it open.
      if (!ref.current?.contains(target) && !target.closest('.float-panel')) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onClose, true)
    window.addEventListener('blur', onClose)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onClose, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const clipboard = (cmd: 'copy' | 'cut') => {
    editor.commands.focus()
    document.execCommand(cmd)
    onClose()
  }

  return (
    <Float>
      <motion.div
        ref={ref}
        className="context-menu"
        role="menu"
        aria-label="Format selection"
        style={{ left: pos.x, top: pos.y }}
        initial={{ opacity: 0, scale: 0.94, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
        transition={{ type: 'spring', stiffness: 520, damping: 32 }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="cm-row">
          <Tool icon={TextB} tip={{ label: 'Bold', keys: 'Ctrl+B' }} active={f.bold} onClick={() => c().toggleBold().run()} />
          <Tool icon={TextItalic} tip={{ label: 'Italic', keys: 'Ctrl+I' }} active={f.italic} onClick={() => c().toggleItalic().run()} />
          <Tool icon={TextUnderline} tip={{ label: 'Underline', keys: 'Ctrl+U' }} active={f.underline} onClick={() => c().toggleUnderline().run()} />
          <ColorTool editor={editor} color={f.color} />
          <span className="tool-divider" />
          <SizeStepper editor={editor} size={f.size} />
        </div>
        <div className="cm-row">
          {ALIGNS.map((a) => (
            <Tool key={a.value} icon={a.icon} tip={a.tip} active={f.align === a.value} onClick={() => c().setTextAlign(a.value).run()} />
          ))}
        </div>
        <div className="cm-sep" />
        <button className="cm-item" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => clipboard('cut')}>
          <Scissors size={16} /> Cut <kbd>Ctrl X</kbd>
        </button>
        <button className="cm-item" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => clipboard('copy')}>
          <Copy size={16} /> Copy <kbd>Ctrl C</kbd>
        </button>
        <button
          className="cm-item"
          role="menuitem"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            onCopyLink()
            onClose()
          }}
        >
          <LinkSimple size={16} /> Copy link to selection
        </button>
        <button
          className="cm-item"
          role="menuitem"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            c().unsetAllMarks().unsetTextAlign().run()
            onClose()
          }}
        >
          <Eraser size={16} /> Clear formatting
        </button>
      </motion.div>
    </Float>
  )
}

/* ───────────── Editor ───────────── */

export default function DocEditor({
  body,
  onChange,
  actions,
  toolbarHost,
}: {
  body: DocBody
  onChange: (b: DocBody) => void
  actions: DocActions
  /** Element in the page's top bar that hosts the formatting toolbar. */
  toolbarHost: HTMLElement | null
}) {
  const [page, setPage] = useState<PageSize>(body.page ?? 'letter')
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  // A shared link (#q=…) to a passage: read once, before anything rewrites the URL.
  const [linked, setLinked] = useState(() => parsePassage(window.location.hash))
  const [outline, setOutline] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem(OUTLINE_KEY)
      if (saved !== null) return saved === '1'
    } catch {
      /* storage unavailable */
    }
    return window.innerWidth >= 1180
  })
  const [notice, setNotice] = useState<{ text: string; tone: 'done' | 'error' } | null>(null)
  const noticeTimer = useRef<number | undefined>(undefined)
  const latest = useRef({ onChange, page })
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    latest.current = { onChange, page }
  })

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false, code: false, codeBlock: false, strike: false, heading: { levels: [1, 2, 3] } }),
      PassageHighlight,
      TextStyle,
      FontSize,
      Color,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      PaginationPlus.configure({
        ...PAGES[page].size,
        pageGap: 28,
        pageGapBorderSize: 0,
        pageGapBorderColor: 'transparent',
        pageBreakBackground: 'var(--canvas)',
        headerLeft: '',
        headerRight: '',
        footerLeft: '',
        footerRight: '<span class="page-number">{page}</span>',
      }),
    ],
    content: body.html,
    autofocus: linked ? false : 'end',
    editorProps: { attributes: { class: 'doc-page', spellcheck: 'true' } },
    // Serialising on every keystroke is wasteful for long docs; batch it.
    onUpdate: ({ editor: e }) => {
      window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => {
        const { onChange: emit, page: p } = latest.current
        emit({ html: e.getHTML(), page: p })
      }, 300)
    },
  })

  useEffect(
    () => () => {
      window.clearTimeout(timer.current)
      window.clearTimeout(noticeTimer.current)
    },
    [],
  )

  const notify = (text: string, tone: 'done' | 'error' = 'done') => {
    window.clearTimeout(noticeTimer.current)
    setNotice({ text, tone })
    noticeTimer.current = window.setTimeout(() => setNotice(null), tone === 'error' ? 6000 : 3200)
  }

  // A passage link pasted while this doc is already open only changes the hash.
  useEffect(() => {
    const onHash = () => {
      const passage = parsePassage(window.location.hash)
      if (passage) setLinked(passage)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Opened from a passage link: wait for pagination to lay out, then land on the text.
  useEffect(() => {
    if (!editor || !linked) return
    window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search)
    const t = window.setTimeout(() => {
      const range = findPassage(editor.state.doc, linked)
      if (!range) {
        editor.view.dispatch(editor.state.tr.setMeta(passageKey, null))
        notify('The linked text has since been changed or removed', 'error')
        return
      }
      editor.chain().setTextSelection(range.from).setMeta(passageKey, range).run()
      scrollToPos(editor, range.from, 'center')
    }, 350)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, linked])

  const toggleOutline = () =>
    setOutline((o) => {
      try {
        localStorage.setItem(OUTLINE_KEY, o ? '0' : '1')
      } catch {
        /* not remembered */
      }
      return !o
    })

  const copyLink = async () => {
    if (!editor) return
    const { from, to, empty } = editor.state.selection
    const passage = empty ? null : makePassage(editor.state.doc, from, to)
    if (!passage) {
      notify('Select the text you want to link to first', 'error')
      return
    }
    const url = `${window.location.origin}${window.location.pathname}#${passageHash(passage)}`
    try {
      await navigator.clipboard.writeText(url)
      notify('Link copied. It opens this doc right at the selected text')
    } catch {
      window.prompt('Copy this link', url)
    }
  }

  // Printing: real @page boxes do the breaking, in light colours regardless of theme.
  useEffect(() => {
    const style = document.createElement('style')
    style.textContent = `@page { size: ${PAGES[page].css}; margin: 1in; }`
    document.head.appendChild(style)
    return () => style.remove()
  }, [page])

  useEffect(() => {
    if (!editor) return
    let previous: string | undefined
    const before = () => {
      previous = document.documentElement.dataset.theme
      applyTheme('light', false)
      editor.commands.disablePagination()
    }
    const after = () => {
      editor.commands.enablePagination()
      if (previous === 'dark') applyTheme('dark', false)
    }
    window.addEventListener('beforeprint', before)
    window.addEventListener('afterprint', after)
    return () => {
      window.removeEventListener('beforeprint', before)
      window.removeEventListener('afterprint', after)
    }
  }, [editor])

  const changePage = (p: PageSize) => {
    setPage(p)
    editor?.chain().updatePageSize(PAGES[p].size).run()
    if (editor) onChange({ html: editor.getHTML(), page: p })
  }

  if (!editor) return null
  return (
    <div className="doc" data-outline={outline || undefined}>
      {toolbarHost &&
        createPortal(
          <Toolbar editor={editor} page={page} onPage={changePage} actions={actions} onCopyLink={copyLink} />,
          toolbarHost,
        )}
      <DocOutline editor={editor} open={outline} onToggle={toggleOutline} />
      <div
        className="doc-canvas"
        onContextMenu={(e) => {
          // Only take over the menu when there is a selection to format.
          if (editor.state.selection.empty) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <AnimatePresence>
        {menu && <ContextMenu key={`${menu.x},${menu.y}`} editor={editor} at={menu} onClose={() => setMenu(null)} onCopyLink={copyLink} />}
      </AnimatePresence>
      <Float>
        <AnimatePresence>
          {notice && (
            <motion.div
              className="toast"
              data-state={notice.tone}
              role="status"
              initial={{ opacity: 0, y: 24, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 16, scale: 0.97, transition: { duration: 0.15 } }}
            >
              <span className="toast-icon">
                <LinkSimple size={20} weight="bold" />
              </span>
              <div className="toast-body">
                <p className="toast-text">{notice.text}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </Float>
    </div>
  )
}
