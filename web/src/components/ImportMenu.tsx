import { ArrowLeft, FolderOpen, LinkSimple, UploadSimple } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { IMPORT_ACCEPT } from '../lib/api'
import GoogleMark from './GoogleMark'

interface Props {
  onFiles: (files: File[]) => void
  onLink: (url: string) => void
  /** Present only when "Pick from Google Drive" is available. */
  onDrive?: () => void
  /** Google sign-in is configured on the server but this user hasn't connected it. */
  canConnectGoogle: boolean
}

const GOOGLE_LINK = /^https?:\/\/(docs|drive)\.google\.com\//

export default function ImportMenu({ onFiles, onLink, onDrive, canConnectGoogle }: Props) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<'menu' | 'link'>('menu')
  const [url, setUrl] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)

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

  const toggle = () => {
    setOpen((o) => !o)
    setMode('menu')
  }

  const submitLink = (e: FormEvent) => {
    e.preventDefault()
    if (!GOOGLE_LINK.test(url.trim())) return
    setOpen(false)
    onLink(url.trim())
    setUrl('')
  }

  return (
    <div className="new-menu" ref={ref}>
      <motion.button className="btn btn-ghost" whileTap={{ scale: 0.95 }} onClick={toggle} aria-expanded={open} aria-haspopup="menu" title="Bring in files from your computer or Google">
        <UploadSimple weight="bold" size={18} />
        Import
      </motion.button>
      <input
        ref={input}
        type="file"
        accept={IMPORT_ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) onFiles(files)
        }}
      />
      <AnimatePresence>
        {open && (
          <motion.div
            className="popover import-popover"
            role="menu"
            initial={{ opacity: 0, y: -8, scale: 0.94 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96, transition: { duration: 0.12 } }}
            style={{ transformOrigin: 'top right' }}
          >
            <AnimatePresence mode="wait" initial={false}>
              {mode === 'menu' ? (
                <motion.div key="menu" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -12 }} transition={{ duration: 0.16 }}>
                  <button
                    role="menuitem"
                    className="popover-item"
                    data-kind="doc"
                    onClick={() => {
                      setOpen(false)
                      input.current?.click()
                    }}
                  >
                    <span className="popover-icon">
                      <FolderOpen weight="fill" />
                    </span>
                    <span>
                      <span className="popover-label">From your computer</span>
                      <span className="popover-hint">Word, Excel, PowerPoint, CSV or Markdown</span>
                    </span>
                  </button>
                  <button role="menuitem" className="popover-item" data-kind="sheet" onClick={() => setMode('link')}>
                    <span className="popover-icon">
                      <LinkSimple weight="bold" />
                    </span>
                    <span>
                      <span className="popover-label">Google link</span>
                      <span className="popover-hint">Paste a Docs, Sheets or Slides link</span>
                    </span>
                  </button>
                  {onDrive && (
                    <button
                      role="menuitem"
                      className="popover-item"
                      data-kind="slides"
                      onClick={() => {
                        setOpen(false)
                        onDrive()
                      }}
                    >
                      <span className="popover-icon import-google">
                        <GoogleMark size={20} />
                      </span>
                      <span>
                        <span className="popover-label">Pick from Google Drive</span>
                        <span className="popover-hint">Choose files in your Drive</span>
                      </span>
                    </button>
                  )}
                  <p className="import-foot">You can also drop files anywhere on this page.</p>
                </motion.div>
              ) : (
                <motion.form key="link" className="import-link" onSubmit={submitLink} initial={{ opacity: 0, x: 12 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 12 }} transition={{ duration: 0.16 }}>
                  <div className="import-link-head">
                    <button type="button" className="icon-btn" onClick={() => setMode('menu')} aria-label="Back" title="Back">
                      <ArrowLeft size={16} />
                    </button>
                    <span className="popover-label">Import a Google link</span>
                  </div>
                  <input
                    className="import-url"
                    type="url"
                    autoFocus
                    placeholder="https://docs.google.com/…"
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    aria-label="Google Docs, Sheets or Slides link"
                  />
                  <p className="import-foot">
                    {onDrive
                      ? 'Works for files in your Drive and anything shared with “Anyone with the link”.'
                      : `The file must be shared with “Anyone with the link”${canConnectGoogle ? ', or connect Google in the sidebar' : ''}.`}
                  </p>
                  <button className="btn btn-primary btn-sm" type="submit" disabled={!GOOGLE_LINK.test(url.trim())}>
                    Import
                  </button>
                </motion.form>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
