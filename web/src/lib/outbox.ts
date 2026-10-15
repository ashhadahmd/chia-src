/** Sends saves left in the local outbox (edits made offline, or whose request failed) once the
    network is back. An open editor sends its own document's saves; this covers the rest. */

import { ApiError, api, NetworkError, type Doc } from './api'
import { local } from './localStore'

const owned = new Set<string>()
let running: Promise<void> | null = null

/** An editor has this document open and saves it itself. */
export function claimDoc(id: string) {
  owned.add(id)
  return () => {
    owned.delete(id)
  }
}

async function run() {
  for (const pending of await local.allPending()) {
    if (owned.has(pending.id)) continue
    try {
      const saved = await api.updateDocument(pending.id, { ...pending.patch, base_revision: pending.base_revision })
      const cached = await local.getDoc(pending.id)
      if (cached) {
        const content = saved.content ?? pending.patch.content ?? cached.doc.content
        await local.putDoc({ ...cached.doc, ...saved, content } as Doc, null)
      }
      await local.dropPending(pending.id)
    } catch (err) {
      if (err instanceof NetworkError) return // still offline; try again on the next `online`
      if (err instanceof ApiError && (err.status >= 500 || err.status === 429)) continue
      await local.dropPending(pending.id) // refused for good (deleted, or access removed)
    }
  }
}

export function flushOutbox(): Promise<void> {
  if (!navigator.onLine) return Promise.resolve()
  running ??= run().finally(() => {
    running = null
  })
  return running
}
