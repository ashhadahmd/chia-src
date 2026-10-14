/**
 * Links to a passage of a doc. The URL carries the passage's text (plus a little context before
 * and after) rather than positions, so links keep working while the document is edited around it.
 * Format: /d/<id>#q=<text>&p=<before>&s=<after>, with e=<end> when long passages are split.
 */
import { Extension } from '@tiptap/react'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

export interface Passage {
  q: string // the text, or its start when `e` is set
  e?: string // the end of a long passage
  p?: string // context before
  s?: string // context after
}

const CONTEXT = 32
const MAX_QUOTE = 160
const EDGE = 64

/** Plain text of the doc, with the document position of every character. */
function flatten(doc: PMNode) {
  let text = ''
  const pos: number[] = []
  doc.descendants((node, at) => {
    if (!node.isTextblock) return true
    if (text) {
      text += '\n'
      pos.push(at)
    }
    node.forEach((child, offset) => {
      const start = at + 1 + offset
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) pos.push(start + i)
        text += child.text
      } else if (child.type.name === 'hardBreak') {
        text += '\n'
        pos.push(start)
      }
    })
    return false
  })
  return { text, pos }
}

function lowerBound(list: number[], value: number) {
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (list[mid] < value) lo = mid + 1
    else hi = mid
  }
  return lo
}

export function makePassage(doc: PMNode, from: number, to: number): Passage | null {
  const { text, pos } = flatten(doc)
  const a = lowerBound(pos, from)
  const b = lowerBound(pos, to)
  const quote = text.slice(a, b)
  if (!quote.trim()) return null
  const passage: Passage = quote.length > MAX_QUOTE ? { q: quote.slice(0, EDGE), e: quote.slice(-EDGE) } : { q: quote }
  const before = text.slice(Math.max(0, a - CONTEXT), a)
  const after = text.slice(b, b + CONTEXT)
  if (before) passage.p = before
  if (after) passage.s = after
  return passage
}

export function passageHash(passage: Passage): string {
  const params = new URLSearchParams()
  for (const key of ['q', 'e', 'p', 's'] as const) if (passage[key]) params.set(key, passage[key])
  return params.toString()
}

export function parsePassage(hash: string): Passage | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const q = params.get('q')
  if (!q) return null
  return { q, e: params.get('e') ?? undefined, p: params.get('p') ?? undefined, s: params.get('s') ?? undefined }
}

function sharedSuffix(a: string, b: string) {
  let n = 0
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++
  return n
}

function sharedPrefix(a: string, b: string) {
  let n = 0
  while (n < a.length && n < b.length && a[n] === b[n]) n++
  return n
}

/** Where the passage is now; the occurrence whose surroundings match best wins. */
export function findPassage(doc: PMNode, passage: Passage): { from: number; to: number } | null {
  const { text, pos } = flatten(doc)
  let best: { start: number; end: number; score: number } | null = null
  for (let i = text.indexOf(passage.q); i !== -1; i = text.indexOf(passage.q, i + 1)) {
    let end = i + passage.q.length
    if (passage.e) {
      const j = text.indexOf(passage.e, end - Math.min(passage.q.length, passage.e.length))
      if (j === -1) continue
      end = Math.max(end, j + passage.e.length)
    }
    const score =
      (passage.p ? sharedSuffix(text.slice(Math.max(0, i - passage.p.length), i), passage.p) : 0) +
      (passage.s ? sharedPrefix(text.slice(end, end + passage.s.length), passage.s) : 0)
    if (!best || score > best.score) best = { start: i, end, score }
  }
  return best ? { from: pos[best.start], to: pos[best.end - 1] + 1 } : null
}

/* Highlight for the passage a link pointed at; cleared by the next click in the doc. */

export const passageKey = new PluginKey<DecorationSet>('passageHighlight')

export const PassageHighlight = Extension.create({
  name: 'passageHighlight',
  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: passageKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            const meta = tr.getMeta(passageKey) as { from: number; to: number } | null | undefined
            if (meta === null) return DecorationSet.empty
            if (meta) return DecorationSet.create(tr.doc, [Decoration.inline(meta.from, meta.to, { class: 'passage-mark' })])
            return tr.docChanged ? set.map(tr.mapping, tr.doc) : set
          },
        },
        props: {
          decorations: (state) => passageKey.getState(state),
          handleDOMEvents: {
            mousedown: (view) => {
              if (passageKey.getState(view.state) !== DecorationSet.empty) view.dispatch(view.state.tr.setMeta(passageKey, null))
              return false
            },
          },
        },
      }),
    ]
  },
})
