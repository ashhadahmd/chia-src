import { CaretRight, SidebarSimple } from '@phosphor-icons/react'
import { useEditorState, type Editor } from '@tiptap/react'
import { AnimatePresence, motion } from 'motion/react'
import { softSpring } from '../lib/kinds'
import { useEffect, useMemo, useRef, useState } from 'react'
import { scrollToPos, TOP_OFFSET } from '../lib/scroll'

interface Heading {
  level: number
  text: string
  pos: number
  key: string
}


function useHeadings(editor: Editor): Heading[] {
  return useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const list: Heading[] = []
      const seen = new Map<string, number>()
      e.state.doc.descendants((node, pos) => {
        if (node.type.name === 'heading') {
          const text = node.textContent.trim()
          const id = `${node.attrs.level}|${text}`
          const n = (seen.get(id) ?? 0) + 1
          seen.set(id, n)
          list.push({ level: node.attrs.level as number, text, pos, key: `${id}|${n}` })
          return false
        }
        return !node.isTextblock
      })
      return list
    },
    equalityFn: (a, b) => b !== null && a.length === b.length && a.every((h, i) => h.key === b[i].key && h.pos === b[i].pos),
  })
}

const PANEL_WIDTH = 248

/** Word-style navigation pane. Collapsed, it is a small "Outline" tab in the same spot and the page re-centres. */
export default function DocOutline({ editor, open, onToggle }: { editor: Editor; open: boolean; onToggle: () => void }) {
  const headings = useHeadings(editor)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [active, setActive] = useState<string | null>(null)
  // A clicked heading stays highlighted until the reader scrolls on their own; headings near
  // the end of the doc can't reach the top of the screen, so scroll-spy alone would miss them.
  const pinned = useRef<string | null>(null)

  // Highlight the section being read: the last heading above the top of the viewport.
  useEffect(() => {
    if (!open || headings.length === 0) return
    let frame = 0
    const unpin = () => {
      pinned.current = null
    }
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (pinned.current) return
        let current: string | null = null
        for (const h of headings) {
          const el = editor.view.nodeDOM(h.pos) as HTMLElement | null
          if (!el?.getBoundingClientRect) continue
          if (el.getBoundingClientRect().top <= TOP_OFFSET + 24) current = h.key
          else break
        }
        setActive(current ?? headings[0].key)
      })
    }
    update()
    const userScroll = ['wheel', 'touchmove', 'keydown'] as const
    window.addEventListener('scroll', update, { passive: true })
    window.addEventListener('resize', update)
    for (const e of userScroll) window.addEventListener(e, unpin, { passive: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
      for (const e of userScroll) window.removeEventListener(e, unpin)
    }
  }, [editor, headings, open])

  // Headings nest under the nearest heading above with a smaller level.
  const rows = useMemo(() => {
    const top = Math.min(...headings.map((h) => h.level))
    const out = []
    let hiddenBelow = Infinity // level of the collapsed heading hiding what follows
    for (const [i, h] of headings.entries()) {
      if (h.level <= hiddenBelow) hiddenBelow = Infinity
      const hidden = hiddenBelow !== Infinity
      const hasChildren = headings[i + 1] !== undefined && headings[i + 1].level > h.level
      if (!hidden && hasChildren && collapsed.has(h.key)) hiddenBelow = h.level
      out.push({ ...h, depth: h.level - top, hidden, hasChildren })
    }
    return out
  }, [headings, collapsed])

  const toggle = (key: string) =>
    setCollapsed((set) => {
      const next = new Set(set)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const go = (h: Heading) => {
    editor.chain().focus().setTextSelection(h.pos + 1).run()
    pinned.current = h.key
    setActive(h.key)
    scrollToPos(editor, h.pos + 1)
  }

  return (
    <motion.div className="outline-rail" data-open={open || undefined} initial={false} animate={{ width: open ? PANEL_WIDTH : 0, marginRight: open ? 24 : 0 }} transition={softSpring}>
      <AnimatePresence initial={false} mode="wait">
        {open ? (
          <motion.aside
            key="panel"
            className="outline"
            aria-label="Document outline"
            initial={{ opacity: 0, x: -14, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -14, scale: 0.97, transition: { duration: 0.12 } }}
            transition={softSpring}
          >
            <header className="outline-head">
              <h2>Outline</h2>
              <motion.button className="icon-btn" onClick={onToggle} aria-label="Hide outline" title="Hide outline" whileTap={{ scale: 0.9 }}>
                <SidebarSimple size={18} weight="fill" />
              </motion.button>
            </header>
            {rows.length === 0 ? (
              <p className="outline-empty">
                Headings you add show up here. Pick <strong>Heading 1</strong>, <strong>2</strong> or <strong>3</strong> from the Style menu, or start a line with <kbd>#</kbd>, <kbd>##</kbd> or <kbd>###</kbd> and a space.
              </p>
            ) : (
              <ol className="outline-list">
                <AnimatePresence initial={false}>
                  {rows.map(
                    (h) =>
                      !h.hidden && (
                        <motion.li
                          key={h.key}
                          style={{ paddingLeft: h.depth * 14 }}
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                        >
                          <span className="outline-caret">
                            {h.hasChildren && (
                              <button
                                className="outline-toggle"
                                onClick={() => toggle(h.key)}
                                aria-label={collapsed.has(h.key) ? `Expand ${h.text}` : `Collapse ${h.text}`}
                                aria-expanded={!collapsed.has(h.key)}
                              >
                                <motion.span animate={{ rotate: collapsed.has(h.key) ? 0 : 90 }} style={{ display: 'inline-flex' }}>
                                  <CaretRight size={11} weight="bold" />
                                </motion.span>
                              </button>
                            )}
                          </span>
                          <button className="outline-item" data-level={h.level} data-active={active === h.key || undefined} onClick={() => go(h)} title={h.text}>
                            {active === h.key && <motion.span layoutId="outline-active" className="outline-active" transition={softSpring} />}
                            <span className="outline-text">{h.text || <em>Untitled heading</em>}</span>
                          </button>
                        </motion.li>
                      ),
                  )}
                </AnimatePresence>
              </ol>
            )}
          </motion.aside>
        ) : (
          <motion.button
            key="tab"
            className="outline-tab"
            onClick={onToggle}
            aria-label="Show outline"
            initial={{ opacity: 0, x: -10, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -10, scale: 0.9, transition: { duration: 0.1 } }}
            whileHover={{ x: 2 }}
            whileTap={{ scale: 0.95 }}
            transition={softSpring}
          >
            <SidebarSimple size={18} />
            <span>Outline</span>
            {headings.length > 0 && <span className="outline-count">{headings.length}</span>}
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  )
}
