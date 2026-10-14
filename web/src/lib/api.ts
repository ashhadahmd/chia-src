const BASE_URL = import.meta.env.VITE_API_URL ?? 'http://localhost:8000'
const TOKEN_KEY = 'chia.token'

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
  title: string
  body: string
}
export interface SlidesBody {
  slides: Slide[]
}

export interface DocSummary {
  id: string
  kind: DocKind
  title: string
  source: 'ui' | 'mcp'
  /** Google editor URL of the Drive backup copy, once one exists. */
  drive_url: string | null
  backed_up_at: string | null
  backup_error: string | null
  created_at: string
  updated_at: string
}

export type Doc = DocSummary &
  (
    | { kind: 'doc'; content: DocBody }
    | { kind: 'sheet'; content: SheetBody }
    | { kind: 'slides'; content: SlidesBody }
  )

export interface User {
  id: number
  email: string
  username: string
  is_root: boolean
}

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

export const UNAUTHORIZED_EVENT = 'chia:unauthorized'

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readToken()
  const headers = new Headers(init.headers)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  if (init.body && !(init.body instanceof URLSearchParams) && !(init.body instanceof FormData))
    headers.set('Content-Type', 'application/json')

  const res = await fetch(`${BASE_URL}${path}`, { ...init, headers })
  if (res.status === 401 && token) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
  if (!res.ok) {
    const detail = await res.json().then((b) => b.detail, () => res.statusText)
    throw new ApiError(res.status, typeof detail === 'string' ? detail : 'Request failed')
  }
  return res.status === 204 ? (undefined as T) : res.json()
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
  const token = readToken()
  const res = await fetch(`${BASE_URL}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
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
  getDocument: (id: string) => request<Doc>(`/api/documents/${id}`),
  createDocument: (kind: DocKind, title = 'Untitled') =>
    request<Doc>('/api/documents', { method: 'POST', body: JSON.stringify({ kind, title }) }),
  updateDocument: (id: string, patch: { title?: string; content?: Doc['content'] }) =>
    request<DocSummary>(`/api/documents/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
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
}

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
