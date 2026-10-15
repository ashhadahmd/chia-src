import { CaretDown, Check, type Icon } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Float } from './Float'
import { useTooltip } from './useTooltip'

export interface Tip {
  label: string
  hint?: string
  keys?: string
}

/* ───────────── Floating layer (tooltips, popovers) ───────────── */
export { Float } from './Float'

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
  const [opener, setOpener] = useState<HTMLElement | null>(null)
  const toggle = (el: HTMLElement) => {
    setOpener(el)
    setAnchor((a) => (a ? null : el.getBoundingClientRect()))
  }

  useEffect(() => {
    if (!anchor) return
    const close = () => setAnchor(null)
    const onDown = (e: MouseEvent) => {
      const own = panel.current
      if (!own || own.contains(e.target as Node)) return
      // The trigger's own click toggles it shut; closing here too would reopen it.
      if (opener?.contains(e.target as Node)) return
      // A popover opened from inside this one (e.g. colours in the toolbar's overflow) mounts later.
      const other = (e.target as Element).closest?.('.float-panel')
      if (other && own.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING) return
      close()
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
  }, [anchor, opener])

  return (
    <>
      {trigger(anchor !== null, toggle)}
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

export interface Choice<T> {
  value: T
  label: string
  hint?: string
  /** Inline style for the label, e.g. to preview a heading size. */
  look?: CSSProperties
}

/** Toolbar dropdown in the same panel style as the Export menu (replaces native <select>). */
export function Select<T extends string | number>({
  value,
  choices,
  onChange,
  tip,
  label,
  className,
  grid,
}: {
  value: T
  choices: Choice<T>[]
  onChange: (value: T) => void
  tip: Tip
  label: string
  className?: string
  /** Lay short choices (like font sizes) out as a grid of this many columns. */
  grid?: number
}) {
  const { bind, node } = useTooltip(tip)
  const current = choices.find((c) => c.value === value)
  return (
    <Popover
      trigger={(open, toggle) => (
        <>
          <button
            type="button"
            className={`select-trigger ${className ?? ''}`}
            aria-label={label}
            aria-haspopup="listbox"
            aria-expanded={open}
            data-open={open || undefined}
            {...bind}
            onMouseDown={(e) => {
              e.preventDefault() // keep the text selection
              bind.onMouseDown()
            }}
            onClick={(e) => toggle(e.currentTarget)}
          >
            <span className="select-value">{current?.label ?? String(value)}</span>
            <CaretDown size={12} weight="bold" />
          </button>
          {node}
        </>
      )}
    >
      {(close) => (
        <div className="select-menu" role="listbox" aria-label={label} data-grid={grid || undefined} style={grid ? { gridTemplateColumns: `repeat(${grid}, 1fr)` } : undefined}>
          {choices.map((c) => (
            <button
              key={c.value}
              type="button"
              role="option"
              aria-selected={c.value === value}
              className="select-option"
              data-active={c.value === value || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onChange(c.value)
                close()
              }}
            >
              <span className="select-text">
                <span className="select-label" style={c.look}>
                  {c.label}
                </span>
                {c.hint && <span className="popover-hint">{c.hint}</span>}
              </span>
              {!grid && c.value === value && <Check size={16} weight="bold" className="select-check" />}
            </button>
          ))}
        </div>
      )}
    </Popover>
  )
}
