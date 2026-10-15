const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
const TOKEN_KEY = 'chia.token'
const WORKSPACE_KEY = 'chia.workspace'

export type DocKind = 'doc' | 'sheet' | 'slides'
export type Cell = string | number | null

export type PageSize = 'letter' | 'a4'
export interface DocBody {
  html: string
  page: PageSize
}
export interface SheetBody {
  columns: string[]
  rows: Cell[][]
}
export interface Slide {
  /** Stable across edits, so concurrent edits merge slide by slide. */
  id?: string
  title: string
  body: string
}
export interface SlidesBody {
  slides: Slide[]
}

export interface DocSummary {
  id: string
  kind: DocKind
  workspace_id: string
  title: string
  source: 'ui' | 'mcp'
  /** Bumped on every change; saves send the one they started from. */
  revision: number
  /** Name of the AI agent behind the latest change; null when the user made it. */
  edited_by: string | null
  /** Name of the AI agent that made the document; null when the user did. */
  created_by: string | null
  /** Google editor URL of the Drive backup copy, once one exists. */
  drive_url: string | null
  backed_up_at: string | null
  backup_error: string | null
  drive_sync_status: 'clean' | 'pending' | 'syncing' | 'failed'
  created_at: string
  updated_at: string
}

export type Role = 'owner' | 'admin' | 'editor' | 'viewer'

/** Everyone has a personal workspace; teams share team/enterprise ones. */
export interface Workspace {
  id: string
  name: string
  slug: string
  kind: 'personal' | 'team' | 'enterprise'
  plan_tier: 'free' | 'pro' | 'enterprise'
  /** The signed-in user's role there. */
  role: Role
  created_at: string
}

export type Doc = DocSummary &
  /** Your role on this document (owner/admin can share it; viewers can't edit). */
  { role?: Role | null } & (
    | { kind: 'doc'; content: DocBody }
    | { kind: 'sheet'; content: SheetBody }
    | { kind: 'slides'; content: SlidesBody }
  )

/** A save's result. `merged`: someone (often an AI agent) saved since the revision this edit
    was built on, and the server combined both; `content` is then the combined version. */
export interface DocSaved extends DocSummary {
  merged: boolean
  conflicts: string[]
  content: Doc['content'] | null
}

export interface Member {
  user_id: number
  username: string
  email: string
  role: Role
}

export interface Share {
  id: number
  principal_type: 'user' | 'apikey' | 'public_link'
  principal_id: string
  label: string
  role: Role
}

export interface User {
  id: number
  email: string
  username: string
  is_root: boolean
}

export interface DocRevision {
  revision: number
  edited_by: string | null
  updated_at: string
}

/** A key an AI agent uses to reach Chia over MCP; its name labels the agent's edits. */
export interface AgentKey {
  id: number
  name: string
  prefix: string
  /** Workspace the agent is locked to; null follows the personal workspace. */
  workspace_id: string | null
  role: 'editor' | 'viewer'
  created_at: string
  last_used_at: string | null
}

/** Thrown when the request never reached the server (offline, server down). */
export class NetworkError extends Error {}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* storage unavailable: session lasts until reload */
  }
}

/** The workspace requests work in. Unset (solo users) means the personal workspace, so the
    X-Workspace-Id header is only sent once someone picks a team workspace. */
export function readWorkspace(): string | null {
  try {
    return localStorage.getItem(WORKSPACE_KEY)
  } catch {
    return null
  }
}

export function setWorkspace(id: string | null) {
  try {
    if (id) localStorage.setItem(WORKSPACE_KEY, id)
    else localStorage.removeItem(WORKSPACE_KEY)
  } catch {
    /* storage unavailable: stays in the personal workspace */
  }
}

function authHeaders(init?: HeadersInit): Headers {
  const headers = new Headers(init)
  const token = readToken()
  const workspace = readWorkspace()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (workspace) headers.set('X-Workspace-Id', workspace)
  return headers
}

export const UNAUTHORIZED_EVENT = 'chia:unauthorized'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readToken()
  const headers = authHeaders(init.headers)
  if (init.body && !(init.body instanceof URLSearchParams) && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json')

  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, { ...init, headers })
  } catch {
    throw new NetworkError('Chia is unreachable')
  }
  if (res.status === 401 && token) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  if (!res.ok && res.status !== 304) {
    const detail = await res.json().then((b) => b.detail, () => res.statusText)
    throw new ApiError(res.status, typeof detail === 'string' ? detail : 'Request failed')
  }
  return res.status === 204 || res.status === 304 ? (undefined as T) : res.json()
}

/** GET with If-None-Match: `null` when the copy behind `etag` is still current (304). */
async function conditional<T>(path: string, etag: string | null): Promise<{ data: T; etag: string | null } | null> {
  let res: Response
  try {
    res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders(etag ? { 'If-None-Match': etag } : undefined) })
  } catch {
    throw new NetworkError('Chia is unreachable')
  }
  if (res.status === 304) return null
  if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  if (!res.ok) {
    const detail = await res.json().then((b) => b.detail, () => res.statusText)
    throw new ApiError(res.status, typeof detail === 'string' ? detail : 'Request failed')
  }
  return { data: (await res.json()) as T, etag: res.headers.get('ETag') }
}

export interface GoogleStatus {
  configured: boolean
  connected: boolean
  email: string | null
  /** "Pick from Google Drive" is available (connected + Picker configured on the server). */
  picker: boolean
}

export interface PickerConfig {
  access_token: string
  api_key: string
  app_id: string
}

export interface ImportResult {
  documents: DocSummary[]
  /** What the conversion left out, e.g. "2 images left out". */
  notes: string[]
}

/** File types the import endpoint understands (keep in sync with api/app/importer.py). */
export const IMPORT_ACCEPT = '.docx,.xlsx,.xlsm,.csv,.tsv,.pptx,.md,.markdown,.txt'

export type ExportFormat = 'pdf' | 'docx' | 'xlsx' | 'pptx'

async function download(path: string, fallbackName: string) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() })
  if (!res.ok) {
    const detail = await res.json().then((b) => b.detail, () => res.statusText)
    throw new ApiError(res.status, typeof detail === 'string' ? detail : 'Export failed')
  }
  const disposition = res.headers.get('Content-Disposition') ?? ''
  const encoded = /filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1]
  const name = encoded ? decodeURIComponent(encoded) : fallbackName
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Docs store images as /api/assets/{id}; the browser needs the API's origin in front. */
export function assetUrl(src: string): string {
  return src.startsWith('/api/') ? `${BASE_URL}${src}` : src
}

/** Full-page browser navigation to the API (OAuth needs a top-level redirect). */
export const googleSignInUrl = `${BASE_URL}/api/auth/google`

export const api = {
  login: (identifier: string, password: string) =>
    request<{ access_token: string }>('/api/auth/token', {
      method: 'POST',
      body: new URLSearchParams({ username: identifier, password }),
    }),
  me: () => request<User>('/api/auth/me'),
  listDocuments: () => request<DocSummary[]>('/api/documents'),
  /** The library, or null when `etag` is still current. Personal workspaces include docs shared with you. */
  listDocumentsIfChanged: (etag: string | null, includeShared: boolean) =>
    conditional<DocSummary[]>(`/api/documents${includeShared ? '?include_shared=true' : ''}`, etag),
  getDocument: (id: string) => request<Doc>(`/api/documents/${id}`),
  getDocumentIfChanged: (id: string, etag: string | null) => conditional<Doc>(`/api/documents/${id}`, etag),
  createDocument: (kind: DocKind, title = 'Untitled') =>
    request<Doc>('/api/documents', { method: 'POST', body: JSON.stringify({ kind, title }) }),
  updateDocument: (id: string, patch: { title?: string; content?: Doc['content']; base_revision?: number }) =>
    request<DocSaved>(`/api/documents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  getRevision: (id: string) => request<DocRevision>(`/api/documents/${id}/revision`),
  deleteDocument: (id: string) => request<void>(`/api/documents/${id}`, { method: 'DELETE' }),
  exportFile: (id: string, format: ExportFormat, title: string, background?: string) =>
    download(
      `/api/documents/${id}/export/${format}${background ? `?background=${encodeURIComponent(background)}` : ''}`,
      `${title}.${format}`,
    ),
  exportGoogle: (id: string) => request<{ url: string }>(`/api/documents/${id}/export/google`, { method: 'POST' }),
  importFile: (file: File) => {
    const body = new FormData()
    body.append('file', file)
    return request<ImportResult>('/api/documents/import', { method: 'POST', body })
  },
  importGoogle: (source: { url: string } | { file_id: string }) =>
    request<ImportResult>('/api/documents/import/google', { method: 'POST', body: JSON.stringify(source) }),
  uploadAsset: (image: Blob, name = 'image') => {
    const body = new FormData()
    body.append('file', image, name)
    return request<{ id: string; url: string; media_type: string }>('/api/assets', { method: 'POST', body })
  },
  googlePicker: () => request<PickerConfig>('/api/google/picker'),
  providers: () => request<{ google: boolean }>('/api/auth/providers'),
  googleStatus: () => request<GoogleStatus>('/api/google'),
  googleConnect: () => request<{ auth_url: string }>('/api/google/connect', { method: 'POST' }),
  googleDisconnect: () => request<void>('/api/google', { method: 'DELETE' }),
  listWorkspaces: () => request<Workspace[]>('/api/workspaces'),
  createWorkspace: (name: string) => request<Workspace>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name, kind: 'team' }) }),
  listMembers: (workspace: string) => request<Member[]>(`/api/workspaces/${workspace}/members`),
  setMember: (workspace: string, user: string, role: Role) =>
    request<Member>(`/api/workspaces/${workspace}/members`, { method: 'PUT', body: JSON.stringify({ user, role }) }),
  removeMember: (workspace: string, userId: number) => request<void>(`/api/workspaces/${workspace}/members/${userId}`, { method: 'DELETE' }),
  listShares: (id: string) => request<Share[]>(`/api/documents/${id}/shares`),
  share: (id: string, principal: string, role: Role) =>
    request<Share>(`/api/documents/${id}/shares`, { method: 'POST', body: JSON.stringify({ principal, role }) }),
  unshare: (id: string, shareId: number) => request<void>(`/api/documents/${id}/shares/${shareId}`, { method: 'DELETE' }),
  listKeys: () => request<AgentKey[]>('/api/keys'),
  createKey: (name: string, scope: { workspace_id?: string | null; role?: 'editor' | 'viewer' } = {}) =>
    request<AgentKey & { key: string }>('/api/keys', { method: 'POST', body: JSON.stringify({ name, ...scope }) }),
  revokeKey: (id: number) => request<void>(`/api/keys/${id}`, { method: 'DELETE' }),
}

/** The realtime change feed (see lib/realtime.ts). */
export const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/api/ws`

/** Where AI agents connect (streamable HTTP MCP). */
export const MCP_URL = `${BASE_URL}/mcp`

/** Backend stores UTC; SQLite drops the offset, so treat bare timestamps as UTC. */
export function parseDate(value: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000],
  ['month', 2592000],
  ['week', 604800],
  ['day', 86400],
  ['hour', 3600],
  ['minute', 60],
]

export function timeAgo(value: string): string {
  const seconds = (parseDate(value).getTime() - Date.now()) / 1000
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}
