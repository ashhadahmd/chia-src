import { type Icon } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type FocusEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export interface Tip {
  label: string
  hint?: string
  keys?: string
}

/* ───────────── Floating layer (tooltips, popovers) ───────────── */

/** Renders into <body> so toolbar overflow never clips it. */
export function Float({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}

export function useTooltip(tip: Tip | undefined) {
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

export function Tool({ icon: I, tip, active, disabled, onClick }: { icon: Icon; tip: Tip; active?: boolean; disabled?: boolean; onClick: () => void }) {
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

export function Popover({
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
