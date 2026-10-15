import { Eye, Printer } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router'
import Brand from '../components/Brand'
import DocEditor from '../components/DocEditor'
import SheetEditor from '../components/SheetEditor'
import SlidesEditor from '../components/SlidesEditor'
import { api, ApiError, timeAgo, type PublicDoc } from '../lib/api'
import { KINDS, softSpring } from '../lib/kinds'
import { printNow, usePrintSetup } from '../lib/print'

const ignore = () => {}

/** A document opened through its public link (/p/:token): read-only, no sign-in. Sheets show
    their formulas evaluated, as in the editor. */
export default function PublicView() {
  const { token = '' } = useParams()
  const [doc, setDoc] = useState<PublicDoc | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    api.readPublic(token).then(
      (d) => {
        if (!alive) return
        setDoc(d)
        document.title = `${d.title || 'Untitled'} · Chia`
      },
      (err) => alive && setProblem(err instanceof ApiError ? err.message : 'Chia is unreachable right now'),
    )
    return () => {
      alive = false
    }
  }, [token])

  usePrintSetup(doc?.kind)

  if (problem)
    return (
      <main className="editor">
        <div className="empty">
          <h2>{problem}</h2>
          <Link to="/" className="btn btn-ghost">
            Go to Chia
          </Link>
        </div>
      </main>
    )
  if (!doc) return <div className="boot" aria-busy="true" />

  const { icon: Icon, label } = KINDS[doc.kind]
  return (
    <motion.main className="editor public-view" data-kind={doc.kind} initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={softSpring}>
      <header className="editor-bar" data-kind={doc.kind}>
        <div className="editor-top">
          <Link to="/" className="public-brand" aria-label="Chia">
            <Brand size={26} />
          </Link>
          <span className="editor-kind" title={label}>
            <Icon weight="fill" size={22} />
          </span>
          <div className="editor-heading">
            <h1 className="editor-title public-title">{doc.title || 'Untitled'}</h1>
            <div className="editor-status">
              <span className="badge" title="Shared with a public link">
                <Eye size={12} weight="fill" /> View only
              </span>
              <span className="public-updated">Updated {timeAgo(doc.updated_at)}</span>
            </div>
          </div>
          <div className="editor-actions">
            <button type="button" className="btn btn-ghost btn-sm" onClick={printNow} title="Print or save as PDF">
              <Printer size={16} weight="bold" /> Print / PDF
            </button>
          </div>
        </div>
      </header>
      <div className="editor-body">
        {doc.kind === 'doc' && <DocEditor body={doc.content} onChange={ignore} toolbarHost={null} readOnly />}
        {doc.kind === 'sheet' && <SheetEditor body={doc.content} onChange={ignore} readOnly />}
        {doc.kind === 'slides' && <SlidesEditor body={doc.content} onChange={ignore} readOnly />}
      </div>
    </motion.main>
  )
}
