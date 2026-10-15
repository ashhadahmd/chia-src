import { X } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useEffect, type ReactNode } from 'react'
import { Float } from './EditorUI'

/** A small modal in the same style as the AI agents dialog. Wrap in <AnimatePresence>. */
export default function Dialog({ title, intro, onClose, children }: { title: string; intro?: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  const id = `dialog-${title.replace(/\W+/g, '-').toLowerCase()}`
  return (
    <Float>
      <motion.div className="dialog-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: { duration: 0.16 } }} onMouseDown={onClose}>
        <motion.div
          className="dialog agents-dialog small-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby={id}
          initial={{ opacity: 0, y: 18, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.98, transition: { duration: 0.14 } }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="dialog-head">
            <div>
              <h2 id={id}>{title}</h2>
              {intro && <p>{intro}</p>}
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="Close">
              <X />
            </button>
          </header>
          <div className="agents-body">{children}</div>
        </motion.div>
      </motion.div>
    </Float>
  )
}
