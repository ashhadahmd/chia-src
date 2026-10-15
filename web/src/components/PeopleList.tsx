import { Trash } from '@phosphor-icons/react'
import { useState, type FormEvent } from 'react'
import type { Role } from '../lib/api'
import { ROLE_LABELS } from '../lib/roles'
import { Select } from './EditorUI'

export interface Person {
  key: string | number
  name: string
  detail?: string
  role: Role
  /** Owners and similar can't be changed or removed. */
  fixed?: boolean
}

/** Invite box plus the list of people with access: shared by Share and Members. */
export default function PeopleList({
  people,
  roles,
  canManage,
  onInvite,
  onRole,
  onRemove,
  placeholder = 'Email or username',
}: {
  people: Person[] | null
  roles: Role[]
  canManage: boolean
  onInvite: (who: string, role: Role) => Promise<void>
  onRole?: (person: Person, role: Role) => Promise<void>
  onRemove: (person: Person) => Promise<void>
  placeholder?: string
}) {
  const [who, setWho] = useState('')
  const [role, setRole] = useState<Role>(roles[roles.length - 1])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const choices = roles.map((r) => ({ value: r, label: ROLE_LABELS[r] }))

  const act = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const invite = (e: FormEvent) => {
    e.preventDefault()
    if (who.trim()) void act(async () => {
      await onInvite(who.trim(), role)
      setWho('')
    })
  }

  return (
    <div className="people">
      {canManage && (
        <form className="people-invite" onSubmit={invite}>
          <input className="input" value={who} onChange={(e) => setWho(e.target.value)} placeholder={placeholder} aria-label="Who to invite" autoFocus />
          <Select label="Access" tip={{ label: 'Access', hint: 'What they can do' }} value={role} choices={choices} onChange={setRole} />
          <button className="btn btn-primary btn-sm" disabled={busy || !who.trim()}>
            Invite
          </button>
        </form>
      )}
      {error && <p className="form-error">{error}</p>}
      <ul className="agents-list people-list">
        {people === null ? (
          <li className="agent people-empty">Loading…</li>
        ) : people.length === 0 ? (
          <li className="agent people-empty">Only you so far.</li>
        ) : (
          people.map((p) => (
            <li key={p.key} className="agent">
              <div className="agent-row">
                <span className="avatar" aria-hidden="true">{p.name.slice(0, 1).toUpperCase()}</span>
                <span className="agent-text">
                  <span className="agent-name">{p.name}</span>
                  {p.detail && <span className="agent-sub">{p.detail}</span>}
                </span>
                {canManage && !p.fixed && onRole ? (
                  <Select label={`Access for ${p.name}`} tip={{ label: 'Access' }} value={p.role} choices={choices} onChange={(r) => void act(() => onRole(p, r))} />
                ) : (
                  <span className="people-role">{ROLE_LABELS[p.role]}</span>
                )}
                {canManage && !p.fixed && (
                  <button className="icon-btn" disabled={busy} onClick={() => void act(() => onRemove(p))} aria-label={`Remove ${p.name}`} title="Remove">
                    <Trash size={16} />
                  </button>
                )}
              </div>
            </li>
          ))
        )}
      </ul>
    </div>
  )
}
