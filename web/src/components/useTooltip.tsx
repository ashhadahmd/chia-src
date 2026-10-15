import { motion } from 'motion/react'
import { useEffect, useRef, useState, type FocusEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { Tip } from './EditorUI'
import { Float } from './Float'

/** Hover/focus tooltip for a control: spread `bind` on it and render `node` next to it. */
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
