/* Doc nodes for pictures and diagrams. Both are blocks the editor shows through React views
   (components/MediaViews.tsx) and serialise to plain HTML that exports understand. */
import { Extension, Node, ReactNodeViewRenderer, type Editor } from '@tiptap/react'
import { Plugin } from '@tiptap/pm/state'
import { DiagramView, ImageView } from '../components/MediaViews'
import { autoWidth, clampWidth, type Align } from './media'

function percent(value: string | null): number | null {
  const n = value ? parseFloat(value) : NaN
  return Number.isFinite(n) && n > 0 ? clampWidth(n) : null
}

function readAlign(el: HTMLElement): Align {
  const a = el.getAttribute('data-align')
  return a === 'left' || a === 'right' ? a : 'center'
}

/** Inline layout so exports (PDF, Google Docs) place the picture like the editor does. */
function boxStyle(width: number | null, align: Align): string {
  const margins =
    align === 'left' ? 'margin-left: 0; margin-right: auto' : align === 'right' ? 'margin-left: auto; margin-right: 0' : 'margin-left: auto; margin-right: auto'
  return `display: block; ${width ? `width: ${width}%; ` : ''}${margins}`
}

export function insertImages(editor: Editor, srcs: string[], at?: number) {
  const nodes = srcs.map((src) => ({ type: 'image', attrs: { src } }))
  if (at === undefined) editor.chain().focus().insertContent(nodes).run()
  else editor.chain().focus().insertContentAt(at, nodes).run()
}

export const ImageBlock = Node.create({
  name: 'image',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addAttributes() {
    return {
      src: { default: null, rendered: false },
      alt: { default: '', rendered: false },
      width: { default: null, rendered: false }, // % of the text column; null: natural size
      align: { default: 'center', rendered: false },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'img[src]',
        getAttrs: (el) => ({
          src: el.getAttribute('src'),
          alt: el.getAttribute('alt') ?? '',
          width: percent(el.getAttribute('data-width') ?? (el.style.width.endsWith('%') ? el.style.width : null)),
          align: readAlign(el),
        }),
      },
    ]
  },
  renderHTML({ node }) {
    const { src, alt, width, align } = node.attrs
    return ['img', { src, alt, 'data-align': align, ...(width ? { 'data-width': String(width) } : {}), style: boxStyle(width, align) }]
  },
  addNodeView() {
    return ReactNodeViewRenderer(ImageView)
  },
})

/** Pictures pasted or dropped straight into the doc. */
export const ImageInput = Extension.create<{ onFiles: (files: File[], at?: number) => void }>({
  name: 'imageInput',
  addOptions() {
    return { onFiles: () => undefined }
  },
  addProseMirrorPlugins() {
    const images = (list: FileList | undefined | null) => Array.from(list ?? []).filter((f) => f.type.startsWith('image/'))
    return [
      new Plugin({
        props: {
          handlePaste: (_view, event) => {
            const files = images(event.clipboardData?.files)
            if (!files.length) return false
            this.options.onFiles(files)
            return true
          },
          handleDrop: (view, event, _slice, moved) => {
            const files = images(event.dataTransfer?.files)
            if (moved || !files.length) return false
            event.preventDefault()
            const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            this.options.onFiles(files, at)
            return true
          },
        },
      }),
    ]
  },
})

export interface DiagramOptions {
  onEdit: (pos: number, code: string) => void
}

export const Diagram = Node.create<DiagramOptions>({
  name: 'diagram',
  group: 'block',
  atom: true,
  draggable: true,
  selectable: true,
  addOptions() {
    return { onEdit: () => undefined }
  },
  addAttributes() {
    return {
      code: { default: '', rendered: false },
      src: { default: null, rendered: false }, // light-theme picture used by exports
      width: { default: null, rendered: false }, // null: sized from the drawing
      natural: { default: null, rendered: false }, // drawn width in px, for that automatic size
      align: { default: 'center', rendered: false },
    }
  },
  parseHTML() {
    return [
      {
        tag: 'figure[data-type="diagram"]',
        getAttrs: (el) => ({
          code: el.getAttribute('data-code') ?? '',
          src: el.querySelector('img')?.getAttribute('src') ?? null,
          width: el.hasAttribute('data-auto') ? null : percent(el.getAttribute('data-width')),
          natural: Number(el.getAttribute('data-natural')) || null,
          align: readAlign(el),
        }),
      },
    ]
  },
  renderHTML({ node }) {
    const { code, src, width, natural, align } = node.attrs
    const shown = width ?? autoWidth(natural)
    const attrs: Record<string, string> = {
      'data-type': 'diagram',
      'data-code': code,
      'data-width': String(shown),
      'data-align': align,
      style: boxStyle(shown, align),
    }
    if (width === null) attrs['data-auto'] = ''
    if (natural) attrs['data-natural'] = String(natural)
    return src ? ['figure', attrs, ['img', { src, alt: 'Diagram', style: 'width: 100%' }]] : ['figure', attrs]
  },
  addNodeView() {
    return ReactNodeViewRenderer(DiagramView)
  },
})
