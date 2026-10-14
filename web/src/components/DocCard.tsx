import { CloudCheck, Robot, Trash } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { Link } from 'react-router'
import { timeAgo, type DocSummary } from '../lib/api'
import { KINDS, softSpring } from '../lib/kinds'

function Thumbnail({ kind }: { kind: DocSummary['kind'] }) {
  if (kind === 'sheet')
    return (
      <div className="thumb-grid" aria-hidden="true">
        {Array.from({ length: 15 }, (_, i) => <span key={i} />)}
      </div>
    )
  if (kind === 'slides')
    return (
      <div className="thumb-slide" aria-hidden="true">
        <span className="thumb-slide-title" />
        <span className="thumb-line w70" />
        <span className="thumb-line w50" />
      </div>
    )
  return (
    <div className="thumb-page" aria-hidden="true">
      <span className="thumb-line w60 strong" />
      <span className="thumb-line" />
      <span className="thumb-line w90" />
      <span className="thumb-line w75" />
    </div>
  )
}

export default function DocCard({ doc, index, onDelete }: { doc: DocSummary; index: number; onDelete: (doc: DocSummary) => void }) {
  const { icon: Icon, label } = KINDS[doc.kind]
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 14, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ ...softSpring, delay: Math.min(index, 12) * 0.03 }}
    >
      <motion.div whileHover={{ y: -4 }} whileTap={{ scale: 0.98 }} className="card-wrap">
        <Link to={`/d/${doc.id}`} className="card" data-kind={doc.kind}>
          <div className="card-preview">
            <Thumbnail kind={doc.kind} />
          </div>
          <div className="card-body">
            <span className="card-kind">
              <Icon size={16} weight="fill" />
              {label}
              {doc.source === 'mcp' && (
                <span className="badge" title="Created by an AI agent over MCP">
                  <Robot size={12} weight="fill" /> AI
                </span>
              )}
            </span>
            <h3 className="card-title">{doc.title}</h3>
            <span className="card-time">
              Edited {timeAgo(doc.updated_at)}
              {doc.drive_url && (
                <span className="card-drive" title="Backed up to Google Drive">
                  <CloudCheck size={14} weight="fill" />
                </span>
              )}
            </span>
          </div>
        </Link>
        <button
          className="card-delete"
          aria-label={`Delete ${doc.title}`}
          title="Delete"
          onClick={() => onDelete(doc)}
        >
          <Trash size={16} />
        </button>
      </motion.div>
    </motion.li>
  )
}
