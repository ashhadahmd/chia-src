import { ArrowsClockwise, PencilSimple, TextAlignCenter, TextAlignLeft, TextAlignRight, TextT, Trash, type Icon } from '@phosphor-icons/react'
import { NodeViewWrapper, type ReactNodeViewProps } from '@tiptap/react'
import { motion } from 'motion/react'
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { api, assetUrl } from '../lib/api'
import { renderDiagram, useMode, type Rendered } from '../lib/diagram'
import { autoWidth, clampWidth, diagramPicture, IMAGE_ACCEPT, prepareImage, uploadImages, type Align } from '../lib/media'
import type { DiagramOptions } from '../lib/mediaNodes'
import { Tool } from './EditorUI'

const ALIGNS: { value: Align; icon: Icon; label: string }[] = [
  { value: 'left', icon: TextAlignLeft, label: 'Align left' },
  { value: 'center', icon: TextAlignCenter, label: 'Centre' },
  { value: 'right', icon: TextAlignRight, label: 'Align right' },
]
const SIZES = [
  { value: 33, label: 'S', tip: 'Small: a third of the page width' },
  { value: 50, label: 'M', tip: 'Medium: half the page width' },
  { value: 75, label: 'L', tip: 'Large: three quarters of the page width' },
  { value: 100, label: 'Full', tip: 'Full page width' },
]

/* ───────────── Shared frame: resize handles + floating bar ───────────── */

function MediaFrame({
  kind,
  width,
  align,
  selected,
  editable,
  onResize,
  bar,
  children,
}: {
  kind: 'image' | 'diagram'
  width: number | null
  align: Align
  selected: boolean
  editable: boolean
  onResize: (width: number) => void
  bar: ReactNode
  children: ReactNode
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [live, setLive] = useState<number | null>(null)
  const shown = live ?? width

  const startResize = (side: 'left' | 'right') => (e: ReactPointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const column = wrap.current!.getBoundingClientRect().width
    const startWidth = frame.current!.getBoundingClientRect().width
    const startX = e.clientX
    const factor = align === 'center' ? 2 : 1 // a centred picture grows on both sides
    let latest: number | null = null
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - startX) * (side === 'right' ? 1 : -1) * factor
      latest = clampWidth(((startWidth + dx) / column) * 100)
      setLive(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (latest !== null) onResize(latest)
      setLive(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const active = selected && editable
  return (
    <NodeViewWrapper className="media" data-kind={kind} data-align={align} data-selected={active || undefined} ref={wrap}>
      <div className="media-frame" ref={frame} style={shown ? { width: `${shown}%` } : undefined} data-drag-handle>
        {children}
        {active && (
          <>
            <span className="media-handle" data-side="left" onPointerDown={startResize('left')} aria-hidden />
            <span className="media-handle" data-side="right" onPointerDown={startResize('right')} aria-hidden />
          </>
        )}
        {live !== null && <span className="media-size">{live}%</span>}
        {active && (
          <motion.div
            className="media-bar"
            contentEditable={false}
            initial={{ opacity: 0, y: 6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 520, damping: 34 }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {bar}
          </motion.div>
        )}
      </div>
    </NodeViewWrapper>
  )
}

function LayoutTools({ width, align, set }: { width: number | null; align: Align; set: (attrs: Record<string, unknown>) => void }) {
  return (
    <>
      {ALIGNS.map((a) => (
        <Tool key={a.value} icon={a.icon} tip={{ label: a.label }} active={align === a.value} onClick={() => set({ align: a.value })} />
      ))}
      <span className="tool-divider" />
      {SIZES.map((s) => (
        <button
          key={s.value}
          type="button"
          className="media-size-btn"
          data-active={width === s.value || undefined}
          title={s.tip}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => set({ width: s.value })}
        >
          {s.label}
        </button>
      ))}
    </>
  )
}

/* ───────────── Images ───────────── */

export function ImageView({ node, updateAttributes, deleteNode, selected, editor }: ReactNodeViewProps) {
  const { src, alt, width, align } = node.attrs as { src: string; alt: string; width: number | null; align: Align }
  const [editingAlt, setEditingAlt] = useState(false)
  const [broken, setBroken] = useState(false)
  const replace = useRef<HTMLInputElement>(null)

  // Pasted web content can carry pictures as data: URLs; store them like any upload.
  useEffect(() => {
    if (!editor.isEditable || !src?.startsWith('data:image/')) return
    let live = true
    fetch(src)
      .then((r) => r.blob())
      .then(prepareImage)
      .then((b) => api.uploadAsset(b))
      .then(({ url }) => live && updateAttributes({ src: url }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [src, editor, updateAttributes])

  return (
    <MediaFrame
      kind="image"
      width={width}
      align={align}
      selected={selected}
      editable={editor.isEditable}
      onResize={(w) => updateAttributes({ width: w })}
      bar={
        editingAlt ? (
          <form
            className="media-alt"
            onSubmit={(e) => {
              e.preventDefault()
              const value = new FormData(e.currentTarget).get('alt')
              updateAttributes({ alt: String(value ?? '').trim() })
              setEditingAlt(false)
            }}
          >
            <input
              name="alt"
              defaultValue={alt}
              autoFocus
              placeholder="Describe the picture for screen readers"
              aria-label="Alt text"
              onKeyDown={(e) => e.key === 'Escape' && setEditingAlt(false)}
            />
            <button className="btn btn-primary btn-sm" type="submit">
              Save
            </button>
          </form>
        ) : (
          <>
            <LayoutTools width={width} align={align} set={updateAttributes} />
            <span className="tool-divider" />
            <Tool icon={TextT} tip={{ label: 'Alt text', hint: alt ? `“${alt}”` : 'Describe the picture for screen readers' }} active={!!alt} onClick={() => setEditingAlt(true)} />
            <Tool icon={ArrowsClockwise} tip={{ label: 'Replace image', hint: 'Pick another picture, keeping size and position' }} onClick={() => replace.current?.click()} />
            <Tool icon={Trash} tip={{ label: 'Remove image', keys: 'Delete' }} onClick={deleteNode} />
            <input
              ref={replace}
              type="file"
              accept={IMAGE_ACCEPT}
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0]
                e.target.value = ''
                if (!file) return
                const [url] = await uploadImages([file]).catch(() => [])
                if (url) updateAttributes({ src: url })
              }}
            />
          </>
        )
      }
    >
      {broken ? (
        <div className="media-broken">This picture couldn’t be loaded</div>
      ) : (
        <img src={assetUrl(src)} alt={alt} draggable={false} onError={() => setBroken(true)} />
      )}
    </MediaFrame>
  )
}

/* ───────────── Diagrams ───────────── */

export function DiagramView({ node, updateAttributes, deleteNode, selected, editor, extension, getPos }: ReactNodeViewProps) {
  const { code, src, width, natural, align } = node.attrs as { code: string; src: string | null; width: number | null; natural: number | null; align: Align }
  const mode = useMode()
  const [drawn, setDrawn] = useState<Rendered | null>(null)
  const [error, setError] = useState<string | null>(null)
  const edit = () => {
    const pos = getPos()
    if (typeof pos === 'number') (extension.options as DiagramOptions).onEdit(pos, code)
  }

  useEffect(() => {
    let live = true
    renderDiagram(code, mode).then(
      (r) => {
        if (!live) return
        setDrawn(r)
        setError(null)
      },
      (err: Error) => live && setError(err.message),
    )
    return () => {
      live = false
    }
  }, [code, mode])

  // Diagrams written by Claude through MCP arrive as source only: make their export picture.
  useEffect(() => {
    if (src || !code || !editor.isEditable) return
    let live = true
    diagramPicture(code)
      .then((p) => live && updateAttributes({ src: p.src, natural: p.natural }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [src, code, editor, updateAttributes])

  return (
    <MediaFrame
      kind="diagram"
      width={width ?? autoWidth(natural ?? drawn?.width ?? null)}
      align={align}
      selected={selected}
      editable={editor.isEditable}
      onResize={(w) => updateAttributes({ width: w })}
      bar={
        <>
          <button type="button" className="btn btn-ghost btn-sm media-edit" onMouseDown={(e) => e.preventDefault()} onClick={edit}>
            <PencilSimple size={15} weight="bold" /> Edit diagram
          </button>
          <span className="tool-divider" />
          <LayoutTools width={width} align={align} set={updateAttributes} />
          <span className="tool-divider" />
          <Tool icon={Trash} tip={{ label: 'Remove diagram', keys: 'Delete' }} onClick={deleteNode} />
        </>
      }
    >
      {error ? (
        <div className="media-broken" onDoubleClick={edit}>
          <strong>This diagram has a mistake</strong>
          <span>{error}</span>
        </div>
      ) : drawn ? (
        <div className="diagram-svg" onDoubleClick={edit} dangerouslySetInnerHTML={{ __html: drawn.svg }} />
      ) : (
        <div className="diagram-loading">
          <span className="spinner" />
        </div>
      )}
    </MediaFrame>
  )
}
