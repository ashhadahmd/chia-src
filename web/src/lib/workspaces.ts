/** The signed-in user's workspaces and which one the app is working in.

    Solo users only ever have their personal workspace and never see a choice. Picking a team
    workspace stores its id, which api.ts then sends as X-Workspace-Id. */

import { useSyncExternalStore } from 'react'
import { api, readWorkspace, setWorkspace, type Workspace } from './api'
import { local } from './localStore'
import { resubscribe } from './realtime'

interface State {
  list: Workspace[] | null
  active: string | null // a workspace id; null = personal
}

let state: State = { list: null, active: readWorkspace() }
const subscribers = new Set<() => void>()

function set(next: Partial<State>) {
  state = { ...state, ...next }
  subscribers.forEach((fn) => fn())
}

function subscribe(fn: () => void) {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

/** Keep the stored choice only while it is still one of the user's workspaces. */
function settle(list: Workspace[]) {
  const active = state.active && list.some((w) => w.id === state.active && w.kind !== 'personal') ? state.active : null
  if (active !== state.active) {
    setWorkspace(active)
    resubscribe()
  }
  set({ list, active })
}

/** Load the list: the cached copy at once, then the server's. */
export async function loadWorkspaces() {
  const cached = await local.getMeta<Workspace[]>('workspaces')
  if (cached && !state.list) set({ list: cached })
  try {
    const list = await api.listWorkspaces()
    void local.putMeta('workspaces', list)
    settle(list)
  } catch {
    /* offline: the cached list stands */
  }
}

export function switchWorkspace(id: string | null) {
  const personal = !id || state.list?.find((w) => w.id === id)?.kind === 'personal'
  const active = personal ? null : id
  setWorkspace(active)
  set({ active })
  resubscribe()
}

export async function createTeam(name: string): Promise<Workspace> {
  const made = await api.createWorkspace(name)
  const list = [...(state.list ?? []), made]
  void local.putMeta('workspaces', list)
  set({ list })
  switchWorkspace(made.id)
  return made
}

export function resetWorkspaces() {
  setWorkspace(null)
  set({ list: null, active: null })
}

export function useWorkspaces() {
  const s = useSyncExternalStore(subscribe, () => state)
  const personal = s.list?.find((w) => w.kind === 'personal') ?? null
  const current = (s.active && s.list?.find((w) => w.id === s.active)) || personal
  return { list: s.list, current, personal, isPersonal: !s.active, key: s.active ?? 'personal' }
}
