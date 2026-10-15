import { Check, Copy, Plugs, Robot, Terminal, X } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState } from 'react'
import { api, MCP_URL, timeAgo, type AgentKey } from '../lib/api'
import { useWorkspaces } from '../lib/workspaces'
import { Float, Select } from './EditorUI'

type Shell = 'bash' | 'zsh' | 'fish'

interface Client {
  /** Also the key's name, which labels the agent's edits in Chia. */
  name: string
  covers: string
  mark: string
  tone: string
  steps: (key: string, shell: Shell) => string[]
  /** The setup reads the key from an environment variable, so the shell matters. */
  usesShell?: boolean
}

const ENV = 'CHIA_MCP_KEY'
const header = (key: string) => `"Authorization: Bearer ${key}"`

function exportKey(key: string, shell: Shell): string {
  if (shell === 'fish') return `set -Ux ${ENV} ${key}`
  return `echo 'export ${ENV}=${key}' >> ~/.${shell}rc && export ${ENV}=${key}`
}

// Each client's own `mcp add` command, so nobody edits config files by hand.
const CLIENTS: Client[] = [
  {
    name: 'Claude Code',
    covers: 'Terminal and the VS Code extension share this setup',
    mark: 'C',
    tone: '#d97757',
    steps: (key) => [`claude mcp add --transport http --scope user chia ${MCP_URL} --header ${header(key)}`],
  },
  {
    name: 'Codex',
    covers: 'Codex CLI and the VS Code extension share this setup',
    mark: 'X',
    tone: '#10a37f',
    usesShell: true,
    steps: (key, shell) => [exportKey(key, shell), `codex mcp add chia --url ${MCP_URL} --bearer-token-env-var ${ENV}`],
  },
  {
    name: 'Gemini CLI',
    covers: 'Google’s Gemini in the terminal',
    mark: 'G',
    tone: '#4f7bec',
    steps: (key) => [`gemini mcp add --scope user --transport http chia ${MCP_URL} --header ${header(key)}`],
  },
  {
    name: 'Copilot CLI',
    covers: 'GitHub Copilot in the terminal',
    mark: 'P',
    tone: '#8957e5',
    steps: (key) => [`copilot mcp add --transport http --header ${header(key)} chia ${MCP_URL}`],
  },
]

const SHELLS: Shell[] = ['bash', 'zsh', 'fish']

/** Sidebar entry for connecting AI agents to Chia over MCP. */
export default function AgentsCard() {
  const [keys, setKeys] = useState<AgentKey[] | null>(null)
  const [open, setOpen] = useState(false)

  useEffect(() => {
    api.listKeys().then(setKeys, () => setKeys([]))
  }, [])

  const connected = CLIENTS.filter((c) => keys?.some((k) => k.name === c.name)).length
  return (
    <>
      <button className="drive-card drive-connect agents-card" onClick={() => setOpen(true)}>
        <Robot size={18} weight={connected ? 'fill' : 'regular'} />
        <span className="drive-text">
          <span className="drive-title">AI agents</span>
          <span className="drive-sub">{connected ? `${connected} connected` : 'Let Claude, Codex and others write here'}</span>
        </span>
      </button>
      <AnimatePresence>{open && <AgentsDialog keys={keys ?? []} onKeys={setKeys} onClose={() => setOpen(false)} />}</AnimatePresence>
    </>
  )
}

function AgentsDialog({ keys, onKeys, onClose }: { keys: AgentKey[]; onKeys: (k: AgentKey[]) => void; onClose: () => void }) {
  // Full keys exist only in this response; they're gone once the dialog closes.
  const [fresh, setFresh] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [shell, setShell] = useState<Shell>(() => (navigator.userAgent.includes('Mac') ? 'zsh' : 'bash'))
  // What new keys may reach: any of your workspaces (personal by default) or one team only,
  // with full editing or read-only access.
  const { list: workspaces } = useWorkspaces()
  const [lock, setLock] = useState<string>('')
  const [role, setRole] = useState<'editor' | 'viewer'>('editor')
  const teams = workspaces?.filter((w) => w.kind !== 'personal') ?? []
  const scopeOf = (k: AgentKey) =>
    [k.workspace_id && `${workspaces?.find((w) => w.id === k.workspace_id)?.name ?? 'one workspace'} only`, k.role === 'viewer' && 'read-only']
      .filter(Boolean)
      .join(' · ')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const reload = () => api.listKeys().then(onKeys, () => undefined)

  const connect = async (client: Client) => {
    setBusy(client.name)
    setError(null)
    try {
      // One key per agent: a new one replaces the old, which stops working.
      for (const k of keys.filter((k) => k.name === client.name)) await api.revokeKey(k.id)
      const made = await api.createKey(client.name, { workspace_id: lock || null, role })
      setFresh((f) => ({ ...f, [client.name]: made.key }))
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not make a key')
    } finally {
      setBusy(null)
    }
  }

  const disconnect = async (client: Client) => {
    if (!window.confirm(`Disconnect ${client.name}? Its key stops working right away.`)) return
    setBusy(client.name)
    setError(null)
    try {
      for (const k of keys.filter((k) => k.name === client.name)) await api.revokeKey(k.id)
      setFresh((f) => Object.fromEntries(Object.entries(f).filter(([name]) => name !== client.name)))
      await reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not disconnect')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Float>
      <motion.div
        className="dialog-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0, transition: { duration: 0.16 } }}
        onMouseDown={onClose}
      >
        <motion.div
          className="dialog agents-dialog"
          role="dialog"
          aria-modal="true"
          aria-labelledby="agents-title"
          initial={{ opacity: 0, y: 18, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 10, scale: 0.98, transition: { duration: 0.14 } }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <header className="dialog-head">
            <div>
              <h2 id="agents-title">Connect AI agents</h2>
              <p>Agents read and write your docs, sheets and slides over MCP. Each gets its own key, and its name shows on whatever it changes.</p>
            </div>
            <button className="icon-btn" onClick={onClose} aria-label="Close" autoFocus>
              <X />
            </button>
          </header>
          <div className="agents-body">
            <div className="agent-scope">
              <span>New keys can reach</span>
              {teams.length > 0 && (
                <Select
                  label="Workspace"
                  tip={{ label: 'Workspace', hint: 'Lock the agent to one team workspace' }}
                  value={lock}
                  choices={[{ value: '', label: 'All my workspaces', hint: 'Personal by default' }, ...teams.map((w) => ({ value: w.id, label: `${w.name} only` }))]}
                  onChange={setLock}
                />
              )}
              <Select
                label="Access"
                tip={{ label: 'Access', hint: 'Read-only agents can look but not change anything' }}
                value={role}
                choices={[
                  { value: 'editor', label: 'Can edit' },
                  { value: 'viewer', label: 'Read-only' },
                ]}
                onChange={setRole}
              />
            </div>
            <ul className="agents-list">
              {CLIENTS.map((client) => {
                const key = keys.find((k) => k.name === client.name)
                const secret = fresh[client.name]
                return (
                  <li key={client.name} className="agent" data-connected={key ? true : undefined}>
                    <div className="agent-row">
                      <span className="agent-mark" style={{ background: client.tone }} aria-hidden="true">
                        {client.mark}
                      </span>
                      <span className="agent-text">
                        <span className="agent-name">{client.name}</span>
                        <span className="agent-sub">
                          {key ? (
                            <>
                              <Check size={12} weight="bold" /> {key.last_used_at ? `Connected · last used ${timeAgo(key.last_used_at)}` : 'Key made · waiting for its first call'}
                              {scopeOf(key) && ` · ${scopeOf(key)}`}
                            </>
                          ) : (
                            client.covers
                          )}
                        </span>
                      </span>
                      {key && (
                        <button className="drive-action" disabled={busy === client.name} onClick={() => disconnect(client)}>
                          Disconnect
                        </button>
                      )}
                      <button className={`btn btn-sm ${key ? 'btn-ghost' : 'btn-primary'}`} disabled={busy === client.name} onClick={() => connect(client)}>
                        {busy === client.name ? <span className="spinner" /> : <Plugs size={15} weight="bold" />}
                        {key ? 'New key' : 'Connect'}
                      </button>
                    </div>
                    <AnimatePresence initial={false}>
                      {secret && (
                        <motion.div className="agent-setup" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}>
                          <div className="agent-setup-inner">
                            <p className="agent-hint">
                              Run {client.steps(secret, shell).length > 1 ? 'these' : 'this'} in a terminal. The key is shown only now{client.usesShell ? '; VS Code picks it up after a restart' : ''}.
                            </p>
                            {client.usesShell && (
                              <div className="agent-shells" role="radiogroup" aria-label="Your shell">
                                {SHELLS.map((s) => (
                                  <button key={s} role="radio" aria-checked={shell === s} data-active={shell === s || undefined} onClick={() => setShell(s)}>
                                    {s}
                                  </button>
                                ))}
                              </div>
                            )}
                            {client.steps(secret, shell).map((cmd, i) => (
                              <Command key={i} text={cmd} />
                            ))}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </li>
                )
              })}
            </ul>
            <details className="agent-other">
              <summary>
                <Terminal size={16} /> Another MCP client
              </summary>
              <p className="agent-hint">
                Point any client that speaks streamable HTTP at this address, sending one of the keys above as <code>Authorization: Bearer &lt;key&gt;</code>.
              </p>
              <Command text={MCP_URL} />
            </details>
            {error && <p className="form-error">{error}</p>}
          </div>
        </motion.div>
      </motion.div>
    </Float>
  )
}

function Command({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(t)
  }, [copied])
  return (
    <div className="agent-cmd">
      <code>{text}</code>
      <button
        className="icon-btn"
        aria-label={copied ? 'Copied' : 'Copy command'}
        title={copied ? 'Copied' : 'Copy'}
        onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true), () => undefined)}
      >
        {copied ? <Check weight="bold" /> : <Copy />}
      </button>
    </div>
  )
}
