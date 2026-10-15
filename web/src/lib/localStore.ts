/** Local-first cache in IndexedDB, with no dependencies.

    - docs: full documents (with the editor's latest local content), so editors open instantly
    - lists: library listings per workspace, with the ETag they came with
    - meta: small things such as the workspace list
    - outbox: one pending save per document, written before it is sent, so edits made offline
      (or lost to a failed request) survive a reload and go out when the network is back

    One database per signed-in user. Every call resolves (to undefined when IndexedDB is
    unavailable, e.g. in a private window) instead of throwing: the app then simply works
    online-only. */

import type { Doc, DocSummary } from './api'

type StoreName = 'docs' | 'lists' | 'meta' | 'outbox'
const STORES: StoreName[] = ['docs', 'lists', 'meta', 'outbox']
const VERSION = 1

export interface CachedDoc {
  doc: Doc
  etag: string | null
}

export interface CachedList {
  docs: DocSummary[]
  etag: string | null
}

export interface PendingSave {
  id: string
  /** The stored revision the local edits are built on; the server merges from there. */
  base_revision: number
  patch: { title?: string; content?: Doc['content'] }
  queued_at: number
}

let dbName: string | null = null
let opening: Promise<IDBDatabase | null> | null = null

function dbFor(userId: number) {
  return `chia-local-${userId}`
}

/** Point the cache at the signed-in user's database (null: signed out). */
export function setLocalUser(userId: number | null) {
  const name = userId === null ? null : dbFor(userId)
  if (name === dbName) return
  opening?.then((db) => db?.close())
  dbName = name
  opening = null
}

/** Remove a user's cached documents and pending saves from this browser (on sign-out). */
export function forgetLocalUser(userId: number) {
  if (dbName === dbFor(userId)) setLocalUser(null)
  try {
    indexedDB.deleteDatabase(dbFor(userId))
  } catch {
    /* IndexedDB unavailable: nothing was stored */
  }
}

function open(): Promise<IDBDatabase | null> {
  if (!dbName) return Promise.resolve(null)
  if (opening) return opening
  const name = dbName
  opening = new Promise((resolve) => {
    try {
      const req = indexedDB.open(name, VERSION)
      req.onupgradeneeded = () => {
        for (const store of STORES) if (!req.result.objectStoreNames.contains(store)) req.result.createObjectStore(store)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return opening
}

function run<T>(store: StoreName, mode: IDBTransactionMode, op: (s: IDBObjectStore) => IDBRequest): Promise<T | undefined> {
  return open().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined)
        try {
          const req = op(db.transaction(store, mode).objectStore(store))
          req.onsuccess = () => resolve(req.result as T)
          req.onerror = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }),
  )
}

const get = <T>(store: StoreName, key: string) => run<T>(store, 'readonly', (s) => s.get(key))
const put = (store: StoreName, key: string, value: unknown) => run(store, 'readwrite', (s) => s.put(value, key)).then(() => undefined)
const remove = (store: StoreName, key: string) => run(store, 'readwrite', (s) => s.delete(key)).then(() => undefined)
const all = <T>(store: StoreName) => run<T[]>(store, 'readonly', (s) => s.getAll()).then((v) => v ?? [])

export const local = {
  getDoc: (id: string) => get<CachedDoc>('docs', id),
  putDoc: (doc: Doc, etag: string | null) => put('docs', doc.id, { doc, etag } satisfies CachedDoc),
  deleteDoc: (id: string) => Promise.all([remove('docs', id), remove('outbox', id)]).then(() => undefined),

  getList: (workspace: string) => get<CachedList>('lists', workspace),
  putList: (workspace: string, docs: DocSummary[], etag: string | null) => put('lists', workspace, { docs, etag } satisfies CachedList),

  getMeta: <T>(key: string) => get<T>('meta', key),
  putMeta: (key: string, value: unknown) => put('meta', key, value),

  getPending: (id: string) => get<PendingSave>('outbox', id),
  putPending: (save: PendingSave) => put('outbox', save.id, save),
  dropPending: (id: string) => remove('outbox', id),
  allPending: () => all<PendingSave>('outbox'),
}
