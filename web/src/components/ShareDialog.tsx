import { Check, Copy, Globe, LinkSimple } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { api, publicUrl, type Share } from '../lib/api'
import Dialog from './Dialog'
import PeopleList from './PeopleList'

/** Give one person access to this document alone, without adding them to a workspace, or turn
    on a read-only link anyone can open without signing in. */
export default function ShareDialog({ docId, title, onClose }: { docId: string; title: string; onClose: () => void }) {
  const [shares, setShares] = useState<Share[] | null>(null)
  const reload = () => api.listShares(docId).then(setShares)
  useEffect(() => {
    api.listShares(docId).then(setShares, () => setShares([]))
  }, [docId])

  const people = shares?.filter((s) => s.principal_type === 'user').map((s) => ({ key: s.id, name: s.label, role: s.role })) ?? null
  const link = shares?.find((s) => s.principal_type === 'public_link') ?? null
  return (
    <Dialog title={`Share “${title || 'Untitled'}”`} intro="People you add find this document in their own library. They get this document only, nothing else of yours." onClose={onClose}>
      <PeopleList
        people={people}
        roles={['editor', 'viewer']}
        canManage
        onInvite={async (who, role) => {
          await api.share(docId, who, role)
          await reload()
        }}
        onRole={async (p, role) => {
          const share = shares?.find((s) => s.id === p.key)
          if (share) await api.share(docId, share.label, role)
          await reload()
        }}
        onRemove={async (p) => {
          await api.unshare(docId, Number(p.key))
          await reload()
        }}
      />
      {shares && <PublicLink docId={docId} link={link} onChanged={reload} />}
    </Dialog>
  )
}

function PublicLink({ docId, link, onChanged }: { docId: string; link: Share | null; onChanged: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])

  const toggle = async () => {
    setBusy(true)
    setError(null)
    try {
      if (link) await api.unshare(docId, link.id)
      else await api.publicLink(docId)
      await onChanged()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the link')
    } finally {
      setBusy(false)
    }
  }
  const url = link ? publicUrl(link.principal_id) : null

  return (
    <section className="public-link" data-on={link ? true : undefined}>
      <div className="public-link-row">
        <span className="public-link-icon" aria-hidden="true">
          {link ? <Globe size={18} weight="fill" /> : <LinkSimple size={18} />}
        </span>
        <span className="public-link-text">
          <span className="public-link-title">Public link</span>
          <span className="public-link-sub">{link ? 'Anyone with the link can view. No sign-in, no editing.' : 'Off. Only the people above can open it.'}</span>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={!!link}
          aria-label="Public link"
          className="switch"
          disabled={busy}
          onClick={toggle}
        >
          <span className="switch-knob" />
        </button>
      </div>
      {url && (
        <div className="agent-cmd">
          <code>{url}</code>
          <button
            className="icon-btn"
            aria-label={copied ? 'Copied' : 'Copy link'}
            title={copied ? 'Copied' : 'Copy link'}
            onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true), () => undefined)}
          >
            {copied ? <Check weight="bold" /> : <Copy />}
          </button>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
    </section>
  )
}
