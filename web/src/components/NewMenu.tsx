import { Plus } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState } from 'react'
import type { DocKind } from '../lib/api'
import { KIND_ORDER, KINDS } from '../lib/kinds'

export default function NewMenu({ onCreate }: { onCreate: (kind: DocKind) => void }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === 'Escape' : !ref.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  return (
    <div className="new-menu" ref={ref}>
      <motion.button
        className="btn btn-primary"
        whileTap={{ scale: 0.95 }}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <motion.span animate={{ rotate: open ? 45 : 0 }} style={{ display: 'inline-flex' }}>
          <Plus weight="bold" size={18} />
        </motion.span>
        New
      </motion.button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="popover"
            role="menu"
            initial={{ opacity: 0, y: -8, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96, transition: { duration: 0.12 } }}
            style={{ transformOrigin: 'top right' }}
          >
            {KIND_ORDER.map((kind) => {
              const { icon: Icon, label, hint } = KINDS[kind]
              return (
                <button
                  key={kind}
                  role="menuitem"
                  className="popover-item"
                  data-kind={kind}
                  onClick={() => {
                    setOpen(false)
                    onCreate(kind)
                  }}
                >
                  <span className="popover-icon">
                    <Icon weight="fill" />
                  </span>
                  <span>
                    <span className="popover-label">{label}</span>
                    <span className="popover-hint">{hint}</span>
                  </span>
                </button>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
