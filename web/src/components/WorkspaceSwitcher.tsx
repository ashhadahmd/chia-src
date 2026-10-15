import { CaretUpDown, Check, Plus, UsersThree } from '@phosphor-icons/react'
import { AnimatePresence } from 'motion/react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { api, type Member, type Workspace } from '../lib/api'
import { useAuth } from '../lib/useAuth'
import { createTeam, switchWorkspace, useWorkspaces } from '../lib/workspaces'
import Dialog from './Dialog'
import { Popover } from './EditorUI'
import PeopleList from './PeopleList'

/** Sidebar control for workspaces. Someone with only their personal workspace sees a single
    quiet "New team workspace" link; teams get a switcher with members. */
export default function WorkspaceSwitcher() {
  const { list, current } = useWorkspaces()
  const [dialog, setDialog] = useState<'new' | 'members' | null>(null)
  const close = useCallback(() => setDialog(null), [])
  const teams = list?.filter((w) => w.kind !== 'personal') ?? []

  return (
    <div className="workspace">
      {teams.length === 0 ? (
        <button className="workspace-new" onClick={() => setDialog('new')}>
          <Plus size={14} weight="bold" /> New team workspace
        </button>
      ) : (
        <Popover
          trigger={(open, toggle) => (
            <button className="workspace-trigger" aria-haspopup="menu" aria-expanded={open} onClick={(e) => toggle(e.currentTarget)}>
              <span className="workspace-mark" data-kind={current?.kind} aria-hidden="true">
                {(current?.name ?? 'P').slice(0, 1).toUpperCase()}
              </span>
              <span className="workspace-name">{current?.name ?? 'Personal'}</span>
              <CaretUpDown size={14} />
            </button>
          )}
        >
          {(closeMenu) => (
            <div className="select-menu" role="menu">
              {(list ?? []).map((w) => (
                <button
                  key={w.id}
                  role="menuitemradio"
                  aria-checked={w.id === current?.id}
                  className="select-option"
                  onClick={() => {
                    switchWorkspace(w.id)
                    closeMenu()
                  }}
                >
                  <span className="select-text">
                    <span className="select-label">{w.name}</span>
                    <span className="popover-hint">{w.kind === 'personal' ? 'Just you' : roleHint(w)}</span>
                  </span>
                  {w.id === current?.id && <Check size={16} weight="bold" className="select-check" />}
                </button>
              ))}
              <hr className="menu-rule" />
              {current && current.kind !== 'personal' && (
                <button
                  role="menuitem"
                  className="select-option"
                  onClick={() => {
                    closeMenu()
                    setDialog('members')
                  }}
                >
                  <span className="select-text">
                    <span className="select-label">
                      <UsersThree size={15} /> Members
                    </span>
                  </span>
                </button>
              )}
              <button
                role="menuitem"
                className="select-option"
                onClick={() => {
                  closeMenu()
                  setDialog('new')
                }}
              >
                <span className="select-text">
                  <span className="select-label">
                    <Plus size={15} /> New team workspace
                  </span>
                </span>
              </button>
            </div>
          )}
        </Popover>
      )}
      <AnimatePresence>
        {dialog === 'new' && <NewTeamDialog key="new" onClose={close} onMade={() => setDialog('members')} />}
        {dialog === 'members' && current && current.kind !== 'personal' && <MembersDialog key="members" workspace={current} onClose={close} />}
      </AnimatePresence>
    </div>
  )
}

function roleHint(w: Workspace) {
  return { owner: 'You own it', admin: 'You manage it', editor: 'You can edit', viewer: 'You can view' }[w.role]
}

function NewTeamDialog({ onClose, onMade }: { onClose: () => void; onMade: () => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createTeam(name.trim())
      onMade()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not create it')
      setBusy(false)
    }
  }

  return (
    <Dialog title="New team workspace" intro="A shared space for your team’s docs, sheets and slides. Your personal workspace stays just yours." onClose={onClose}>
      <form className="people-invite" onSubmit={submit}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" aria-label="Team name" autoFocus />
        <button className="btn btn-primary btn-sm" disabled={busy || !name.trim()}>
          Create
        </button>
      </form>
      {error && <p className="form-error">{error}</p>}
    </Dialog>
  )
}

function MembersDialog({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const { user } = useAuth()
  const [members, setMembers] = useState<Member[] | null>(null)
  const reload = () => api.listMembers(workspace.id).then(setMembers)
  useEffect(() => {
    api.listMembers(workspace.id).then(setMembers, () => setMembers([]))
  }, [workspace.id])
  const canManage = workspace.role === 'owner' || workspace.role === 'admin'

  return (
    <Dialog title={`${workspace.name} members`} intro="Members see and work on everything in this workspace, as their role allows." onClose={onClose}>
      <PeopleList
        people={
          members?.map((m) => ({
            key: m.user_id,
            name: m.user_id === user?.id ? `${m.username} (you)` : m.username,
            detail: m.email,
            role: m.role,
            fixed: m.role === 'owner',
          })) ?? null
        }
        roles={['admin', 'editor', 'viewer']}
        canManage={canManage}
        onInvite={async (who, role) => {
          await api.setMember(workspace.id, who, role)
          await reload()
        }}
        onRole={async (p, role) => {
          const m = members?.find((x) => x.user_id === p.key)
          if (m) await api.setMember(workspace.id, m.username, role)
          await reload()
        }}
        onRemove={async (p) => {
          await api.removeMember(workspace.id, Number(p.key))
          await reload()
        }}
      />
    </Dialog>
  )
}
