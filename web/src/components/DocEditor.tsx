import {
  ArrowClockwise,
  ArrowCounterClockwise,
  Copy,
  DotsThreeVertical,
  Eraser,
  FlowArrow,
  Image as ImageIcon,
  LinkSimple,
  Minus,
  Plus,
  Scissors,
  TextAlignCenter,
  TextAlignJustify,
  TextAlignLeft,
  TextAlignRight,
  TextB,
  TextItalic,
  TextUnderline,
  Trash,
  ArrowsMerge,
  ArrowsSplit,
  ColumnsPlusLeft,
  ColumnsPlusRight,
  RowsPlusBottom,
  RowsPlusTop,
  type Icon,
} from '@phosphor-icons/react'
import { TableKit } from '@tiptap/extension-table'
import { TextAlign } from '@tiptap/extension-text-align'
import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style'
import { Placeholder, TrailingNode } from '@tiptap/extensions'
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { AnimatePresence, motion } from 'motion/react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PAGE_SIZES, PaginationPlus } from 'tiptap-pagination-plus'
import type { DocBody, PageSize } from '../lib/api'
import { findPassage, makePassage, parsePassage, passageHash, passageKey, PassageHighlight } from '../lib/passage'
import { applyTheme } from '../lib/theme'
import { scrollToPos } from '../lib/scroll'
import DiagramDialog from './DiagramDialog'
import DocOutline from './DocOutline'
import { Float, Popover, Select, Tool, useTooltip, type Choice, type Tip } from './EditorUI'
import { Diagram, ImageBlock, ImageInput, insertImages } from '../lib/mediaNodes'
import { TableBar, TableInsert } from './TableTools'
import { canMergeCells, ChiaTableCell, ChiaTableHeader, findTable } from '../lib/table'
import { diagramPicture, IMAGE_ACCEPT, uploadImages } from '../lib/media'

const PAGES: Record<PageSize, { label: string; hint: string; size: typeof PAGE_SIZES.LETTER; css: string }> = {
  letter: { label: 'Letter', hint: '8.5 × 11 in, used in the US', size: PAGE_SIZES.LETTER, css: 'letter' },
  a4: { label: 'A4', hint: '210 × 297 mm, used most elsewhere', size: PAGE_SIZES.A4, css: 'A4' },
}
const BLOCKS: Choice<string>[] = [
  { value: 'p', label: 'Normal text', look: { fontSize: 14 } },
  { value: '1', label: 'Heading 1', look: { fontSize: 21, fontWeight: 800 } },
  { value: '2', label: 'Heading 2', look: { fontSize: 18, fontWeight: 750 } },
  { value: '3', label: 'Heading 3', look: { fontSize: 15.5, fontWeight: 700 } },
]
const OUTLINE_KEY = 'chia.outline'
const SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48]
const DEFAULT_SIZE = 11


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

/* ───────────── Controls ───────────── */

function SizeStepper({ editor, size }: { editor: Editor; size: number }) {
  return (
    <div className="size-stepper" role="group" aria-label="Font size">
      <Tool icon={Minus} tip={{ label: 'Smaller text', hint: 'Step the font size down' }} disabled={size <= SIZES[0]} onClick={() => stepSize(editor, size, -1)} />
      <Select
        className="size-value"
        label="Font size"
        tip={{ label: 'Font size', hint: 'Pick an exact size in points' }}
        value={SIZES.includes(size) ? size : DEFAULT_SIZE}
        choices={SIZES.map((s) => ({ value: s, label: String(s) }))}
        onChange={(s) => setSize(editor, s)}
        grid={4}
      />
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


/* ───────────── Toolbar (rendered inside the editor's top bar) ───────────── */

interface ToolbarProps {
  editor: Editor
  page: PageSize
  onPage: (p: PageSize) => void
  onCopyLink: () => void
  onImages: (files: File[]) => void
  onDiagram: () => void
}

function Toolbar({ editor, page, onPage, onCopyLink, onImages, onDiagram }: ToolbarProps) {
  const picker = useRef<HTMLInputElement>(null)
  const f = useFormat(editor)
  const c = () => editor.chain().focus()
  const setBlock = (value: string) =>
    value === 'p' ? c().setParagraph().run() : c().setHeading({ level: Number(value) as 1 | 2 | 3 }).run()

  // Groups in Google Docs order; the ones that don't fit move into the ⋮ menu, last first.
  const groups: ReactNode[] = [
    <Fragment key="history">
      <Tool icon={ArrowCounterClockwise} tip={{ label: 'Undo', hint: 'Reverse your last change', keys: 'Ctrl+Z' }} disabled={!f.canUndo} onClick={() => c().undo().run()} />
      <Tool icon={ArrowClockwise} tip={{ label: 'Redo', hint: 'Bring back what you undid', keys: 'Ctrl+Shift+Z' }} disabled={!f.canRedo} onClick={() => c().redo().run()} />
    </Fragment>,
    <Fragment key="style">
      <Select
        className="style-select"
        label="Style"
        tip={{ label: 'Style', hint: 'Normal text or a heading. Headings build the outline', keys: 'Ctrl+Alt+1–3' }}
        value={f.block}
        choices={BLOCKS}
        onChange={setBlock}
      />
    </Fragment>,
    <SizeStepper key="size" editor={editor} size={f.size} />,
    <Fragment key="text">
      <Tool icon={TextB} tip={{ label: 'Bold', hint: 'Make text heavier', keys: 'Ctrl+B' }} active={f.bold} onClick={() => c().toggleBold().run()} />
      <Tool icon={TextItalic} tip={{ label: 'Italic', hint: 'Slant text for emphasis', keys: 'Ctrl+I' }} active={f.italic} onClick={() => c().toggleItalic().run()} />
      <Tool icon={TextUnderline} tip={{ label: 'Underline', hint: 'Draw a line under text', keys: 'Ctrl+U' }} active={f.underline} onClick={() => c().toggleUnderline().run()} />
      <ColorTool editor={editor} color={f.color} />
    </Fragment>,
    <Fragment key="insert">
      <Tool icon={LinkSimple} tip={{ label: 'Link to selection', hint: 'Copy a link that opens this doc right at the selected text' }} disabled={f.empty} onClick={onCopyLink} />
      <Tool icon={ImageIcon} tip={{ label: 'Image', hint: 'Add a picture. You can also paste or drop one into the page' }} onClick={() => picker.current?.click()} />
      <TableInsert editor={editor} />
      <Tool icon={FlowArrow} tip={{ label: 'Diagram', hint: 'Flowcharts, timelines, mind maps and more, drawn in Chia’s style' }} onClick={onDiagram} />
    </Fragment>,
    <Fragment key="align">
      {ALIGNS.map((a) => (
        <Tool key={a.value} icon={a.icon} tip={a.tip} active={f.align === a.value} onClick={() => c().setTextAlign(a.value).run()} />
      ))}
    </Fragment>,
    <Fragment key="page">
      <Select
        label="Page size"
        tip={{ label: 'Page size', hint: 'Paper size used for printing and export' }}
        value={page}
        choices={(Object.keys(PAGES) as PageSize[]).map((k) => ({ value: k, label: PAGES[k].label, hint: PAGES[k].hint }))}
        onChange={onPage}
      />
    </Fragment>,
  ]
  const { row, fit } = useFit(groups.length)
  const moreTip = useTooltip({ label: 'More tools', hint: 'Tools that don’t fit this window' })

  return (
    <div className="doc-toolbar" role="toolbar" aria-label="Formatting" ref={row}>
      {groups.slice(0, fit).map((g, i) => (
        <Fragment key={i}>
          {i > 0 && <span className="tool-divider" />}
          <div className="tool-group" data-group={i}>
            {g}
          </div>
        </Fragment>
      ))}
      {fit < groups.length && (
        <>
          <Popover
            align="right"
            trigger={(open, toggle) => (
              <>
                <button
                  type="button"
                  className="tool toolbar-more"
                  data-active={open || undefined}
                  aria-label="More tools"
                  aria-expanded={open}
                  {...moreTip.bind}
                  onMouseDown={(e) => {
                    e.preventDefault()
                    moreTip.bind.onMouseDown()
                  }}
                  onClick={(e) => toggle(e.currentTarget)}
                >
                  <DotsThreeVertical size={18} weight="bold" />
                </button>
                {moreTip.node}
              </>
            )}
          >
            {() => (
              <div className="toolbar-overflow" role="toolbar" aria-label="More tools">
                {groups.slice(fit).map((g, i) => (
                  <div className="tool-group" key={fit + i}>
                    {g}
                  </div>
                ))}
              </div>
            )}
          </Popover>
        </>
      )}
      <input
        ref={picker}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) onImages(files)
        }}
      />
    </div>
  )
}

const DIVIDER = 13 // .tool-divider: 1px + 6px margins
const MORE = 32

/** How many toolbar groups fit in one row, keeping room for the ⋮ button when some don't. */
function useFit(count: number) {
  const row = useRef<HTMLDivElement>(null)
  const widths = useRef<number[]>([])
  const [fit, setFit] = useState(count)

  useLayoutEffect(() => {
    const el = row.current
    if (!el) return
    const measure = () => {
      // Every group is on screen at first, so each has a width by the time any is hidden.
      el.querySelectorAll<HTMLElement>(':scope > .tool-group').forEach((g) => {
        widths.current[Number(g.dataset.group)] = g.offsetWidth
      })
      const style = getComputedStyle(el)
      const room = el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      const total = (n: number) => widths.current.slice(0, n).reduce((a, w, i) => a + w + (i ? DIVIDER : 0), 0)
      let n = count
      if (total(count) > room) {
        n = count - 1
        while (n > 0 && total(n) + DIVIDER + MORE > room) n--
      }
      setFit(n)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [count])

  return { row, fit }
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

  const inTable = findTable(editor.state.selection) !== undefined
  const table = (run: () => void) => {
    run()
    onClose()
  }

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
        {inTable && (
          <>
            <div className="cm-sep" />
            <div className="cm-row">
              <Tool icon={RowsPlusTop} tip={{ label: 'Row above' }} onClick={() => table(() => c().addRowBefore().run())} />
              <Tool icon={RowsPlusBottom} tip={{ label: 'Row below' }} onClick={() => table(() => c().addRowAfter().run())} />
              <Tool icon={ColumnsPlusLeft} tip={{ label: 'Column left' }} onClick={() => table(() => c().addColumnBefore().run())} />
              <Tool icon={ColumnsPlusRight} tip={{ label: 'Column right' }} onClick={() => table(() => c().addColumnAfter().run())} />
              <Tool icon={ArrowsMerge} tip={{ label: 'Merge cells' }} disabled={!canMergeCells(editor)} onClick={() => table(() => c().mergeCells().run())} />
              <Tool icon={ArrowsSplit} tip={{ label: 'Split cell' }} disabled={!editor.can().splitCell()} onClick={() => table(() => c().splitCell().run())} />
            </div>
            <button className="cm-item" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => table(() => c().deleteRow().run())}>
              <Trash size={16} /> Delete row
            </button>
            <button className="cm-item" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => table(() => c().deleteColumn().run())}>
              <Trash size={16} /> Delete column
            </button>
            <button className="cm-item cm-danger" role="menuitem" onMouseDown={(e) => e.preventDefault()} onClick={() => table(() => c().deleteTable().run())}>
              <Trash size={16} /> Delete table
            </button>
          </>
        )}
        {!f.empty && (
          <>
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
          </>
        )}
        {!f.empty && (
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
        )}
      </motion.div>
    </Float>
  )
}

/* ───────────── Editor ───────────── */

export default function DocEditor({
  body,
  onChange,
  toolbarHost,
}: {
  body: DocBody
  onChange: (b: DocBody) => void
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
  const [notice, setNotice] = useState<{ text: string; tone: 'done' | 'error' | 'busy'; icon?: Icon } | null>(null)
  // The diagram being written: pos of an existing one, or null for a new one.
  const [diagram, setDiagram] = useState<{ pos: number | null; code: string } | null>(null)
  // Node views and paste handlers are created once; they call through this.
  const media = useRef({ images: (_files: File[], _at?: number) => {}, editDiagram: (_pos: number, _code: string) => {} })
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
      TableKit.configure({ table: { resizable: true, cellMinWidth: 48, lastColumnResizable: false }, tableCell: false, tableHeader: false }),
      ChiaTableCell,
      ChiaTableHeader,
      ImageBlock,
      ImageInput.configure({ onFiles: (files, at) => media.current.images(files, at) }),
      Diagram.configure({ onEdit: (pos, code) => media.current.editDiagram(pos, code) }),
      TextStyle,
      FontSize,
      Color,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      TrailingNode, // always somewhere to type after a table, picture or diagram
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
        if (e.isDestroyed) return // a node view finished work after this editor was replaced
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

  const notify = (text: string, tone: 'done' | 'error' | 'busy' = 'done', icon?: Icon) => {
    window.clearTimeout(noticeTimer.current)
    setNotice({ text, tone, icon })
    if (tone !== 'busy') noticeTimer.current = window.setTimeout(() => setNotice(null), tone === 'error' ? 6000 : 3200)
  }

  const addImages = async (files: File[], at?: number) => {
    if (!editor) return
    notify(files.length > 1 ? `Adding ${files.length} pictures…` : 'Adding picture…', 'busy', ImageIcon)
    try {
      insertImages(editor, await uploadImages(files), at)
      setNotice(null)
    } catch (err) {
      notify(err instanceof Error ? err.message : 'The picture could not be added', 'error', ImageIcon)
    }
  }

  const saveDiagram = async (code: string) => {
    if (!editor || !diagram) return
    const picture = await diagramPicture(code)
    const at = diagram.pos
    const existing = at === null ? null : editor.state.doc.nodeAt(at)
    if (at !== null && existing?.type.name === 'diagram') {
      editor
        .chain()
        .focus()
        .command(({ tr }) => {
          tr.setNodeMarkup(at, undefined, { ...existing.attrs, code, src: picture.src, natural: picture.natural })
          return true
        })
        .setNodeSelection(at)
        .run()
    } else {
      editor.chain().focus().insertContent({ type: 'diagram', attrs: { code, src: picture.src, natural: picture.natural } }).run()
    }
    setDiagram(null)
  }

  useEffect(() => {
    media.current = { images: addImages, editDiagram: (pos, code) => setDiagram({ pos, code }) }
  })

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
          <Toolbar
            editor={editor}
            page={page}
            onPage={changePage}
            onCopyLink={copyLink}
            onImages={(files) => void addImages(files)}
            onDiagram={() => setDiagram({ pos: null, code: '' })}
          />,
          toolbarHost,
        )}
      <DocOutline editor={editor} open={outline} onToggle={toggleOutline} />
      <div
        className="doc-canvas"
        onContextMenu={(e) => {
          // Only take over the menu when there is a selection to format or a table to edit.
          if (editor.state.selection.empty && !findTable(editor.state.selection)) return
          e.preventDefault()
          setMenu({ x: e.clientX, y: e.clientY })
        }}
      >
        <EditorContent editor={editor} />
      </div>
      <AnimatePresence>
        {menu && <ContextMenu key={`${menu.x},${menu.y}`} editor={editor} at={menu} onClose={() => setMenu(null)} onCopyLink={copyLink} />}
      </AnimatePresence>
      <TableBar editor={editor} />
      <AnimatePresence>
        {diagram && (
          <DiagramDialog key="diagram" initial={diagram.code} editing={diagram.pos !== null} onClose={() => setDiagram(null)} onSave={saveDiagram} />
        )}
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
                {notice.tone === 'busy' ? <span className="spinner" /> : notice.icon ? <notice.icon size={20} weight="bold" /> : <LinkSimple size={20} weight="bold" />}
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
