/** One WebSocket per tab for change notices (see api/app/routes/realtime.py), instead of polling.

    - Open only while the tab is visible and online. A hidden tab closes it, so it costs nothing.
    - Subscribes to the current workspace and, in the editor, the open document.
    - After any gap (tab shown again, reconnect, back online) listeners get a `resync` and
      reconcile with one conditional request. */

import { readToken, readWorkspace, WS_URL, type DocSummary } from './api'

export interface ChangeEvent {
  type: 'doc.created' | 'doc.updated' | 'doc.deleted'
  doc_id: string
  workspace_id: string
  revision: number
  edited_by?: string | null
  /** The library card's data (no content); absent on deletes. */
  doc?: DocSummary
}

type Listener = (event: ChangeEvent) => void

const PING_MS = 45_000 // keeps proxies from dropping a quiet connection, only while visible
const MAX_BACKOFF_MS = 30_000

let socket: WebSocket | null = null
let docId: string | null = null
let retry = 0
let retryTimer: number | undefined
let pingTimer: number | undefined
let started = false
let hadGap = false
const listeners = new Set<Listener>()
const resyncers = new Set<() => void>()

function wanted() {
  return !document.hidden && navigator.onLine && readToken() !== null && (listeners.size > 0 || resyncers.size > 0)
}

function subscription() {
  return { workspace_id: readWorkspace(), doc_id: docId }
}

function connect() {
  window.clearTimeout(retryTimer)
  if (socket || !wanted()) return
  const ws = new WebSocket(WS_URL)
  socket = ws
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: readToken(), ...subscription() }))
  ws.onmessage = (msg) => {
    let data: { type?: string }
    try {
      data = JSON.parse(String(msg.data))
    } catch {
      return
    }
    if (data.type === 'ready') {
      retry = 0
      window.clearInterval(pingTimer)
      pingTimer = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), PING_MS)
      if (hadGap) {
        hadGap = false
        resyncers.forEach((fn) => fn())
      }
    } else if (data.type?.startsWith('doc.')) {
      listeners.forEach((fn) => fn(data as ChangeEvent))
    }
  }
  ws.onclose = (e) => {
    if (socket === ws) socket = null
    window.clearInterval(pingTimer)
    hadGap = true
    if (e.code === 4401) return // the session ended; signing in again starts over
    if (wanted()) {
      retryTimer = window.setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retry++))
    }
  }
}

function disconnect() {
  window.clearTimeout(retryTimer)
  window.clearInterval(pingTimer)
  const ws = socket
  socket = null
  if (ws) {
    hadGap = true
    ws.onclose = null
    ws.close()
  }
}

function sync() {
  if (wanted()) connect()
  else disconnect()
}

function start() {
  if (started) return
  started = true
  document.addEventListener('visibilitychange', sync)
  window.addEventListener('online', sync)
  window.addEventListener('offline', sync)
}

/** Listen for document changes; returns the unsubscribe function. */
export function onChange(fn: Listener): () => void {
  start()
  listeners.add(fn)
  sync()
  return () => {
    listeners.delete(fn)
    sync()
  }
}

/** Called after a gap in the feed (tab shown again, reconnect), to reconcile once. */
export function onResync(fn: () => void): () => void {
  start()
  resyncers.add(fn)
  sync()
  return () => {
    resyncers.delete(fn)
    sync()
  }
}

/** Also follow one open document (null: none). */
export function watchDocument(id: string | null) {
  docId = id
  resubscribe()
}

/** The workspace changed (or the open document did): move the subscription. */
export function resubscribe() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'subscribe', ...subscription() }))
}

/** Signed out: drop the connection. */
export function stopRealtime() {
  disconnect()
}
