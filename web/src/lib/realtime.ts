/** One socket per tab for change notices, instead of polling. Two transports, picked by
    GET /api/realtime/config:

    - `websocket`: the API's own /api/ws (see api/app/routes/realtime.py). Local dev, containers.
    - `aws_appsync`: AWS AppSync Events (the API on Lambda can't hold sockets). The tab
      subscribes to its workspace's channel and the open document's; AppSync asks the API's
      Lambda authorizer whether this user may read each one.

    Either way:
    - Open only while the tab is visible and online. A hidden tab closes it, so it costs nothing.
    - Subscribes to the current workspace and, in the editor, the open document.
    - After any gap (tab shown again, reconnect, back online) listeners get a `resync` and
      reconcile with one conditional request. */

import { api, readToken, readWorkspace, WS_URL, type DocSummary, type RealtimeConfig } from './api'

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

interface Transport {
  close: () => void
  /** The workspace or open document changed. */
  resubscribe: () => void
}

const PING_MS = 45_000 // keeps proxies from dropping a quiet /api/ws connection, only while visible
const MAX_BACKOFF_MS = 30_000

let transport: Transport | null = null
let docId: string | null = null
let retry = 0
let retryTimer: number | undefined
let started = false
let hadGap = false
let config: RealtimeConfig | null = null
let configuring = false
const listeners = new Set<Listener>()
const resyncers = new Set<() => void>()

function wanted() {
  return !document.hidden && navigator.onLine && readToken() !== null && (listeners.size > 0 || resyncers.size > 0)
}

// An event reaches a tab once per channel it is on (its workspace's and its document's);
// each is handled once.
const seen: string[] = []
function deliver(event: ChangeEvent) {
  const key = `${event.type}:${event.doc_id}:${event.revision}`
  if (seen.includes(key)) return
  seen.push(key)
  if (seen.length > 64) seen.shift()
  listeners.forEach((fn) => fn(event))
}

/** Connected and subscribed: reconcile if this follows a gap. */
function ready() {
  retry = 0
  if (hadGap) {
    hadGap = false
    resyncers.forEach((fn) => fn())
  }
}

/** The connection dropped (not closed by us): try again with backoff while still wanted. */
function dropped(owner: Transport, signedOut = false) {
  if (transport !== owner) return
  transport = null
  hadGap = true
  if (!signedOut && wanted()) retryTimer = window.setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retry++))
}

// ───────────── /api/ws ─────────────

function apiSocket(): Transport {
  const ws = new WebSocket(WS_URL)
  let ping: number | undefined
  const subscription = () => ({ workspace_id: readWorkspace(), doc_id: docId })
  const self: Transport = {
    close: () => {
      window.clearInterval(ping)
      ws.onclose = null
      ws.close()
    },
    resubscribe: () => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'subscribe', ...subscription() }))
    },
  }
  ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', token: readToken(), ...subscription() }))
  ws.onmessage = (msg) => {
    let data: { type?: string }
    try {
      data = JSON.parse(String(msg.data))
    } catch {
      return
    }
    if (data.type === 'ready') {
      window.clearInterval(ping)
      ping = window.setInterval(() => ws.readyState === WebSocket.OPEN && ws.send('{"type":"ping"}'), PING_MS)
      ready()
    } else if (data.type?.startsWith('doc.')) {
      deliver(data as ChangeEvent)
    }
  }
  ws.onclose = (e) => {
    window.clearInterval(ping)
    dropped(self, e.code === 4401) // 4401: the session ended; signing in again starts over
  }
  return self
}

// ───────────── AWS AppSync Events ─────────────

const base64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

function appSync(cfg: RealtimeConfig): Transport {
  const auth: Record<string, string> =
    cfg.auth === 'api_key' ? { host: cfg.http_host ?? '', 'x-api-key': cfg.api_key ?? '' } : { host: cfg.http_host ?? '', Authorization: readToken() ?? '' }
  const ws = new WebSocket(cfg.realtime_url ?? '', ['aws-appsync-event-ws', `header-${base64url(JSON.stringify(auth))}`])
  const subs = new Map<string, string>() // channel -> subscription id
  let acked = false
  let pending = 0 // subscriptions awaiting their answer before the first "ready"
  let watchdog: number | undefined
  let timeoutMs = 300_000

  // AppSync sends "ka" keep-alives; silence for longer than it promised means the link is dead.
  const alive = () => {
    window.clearTimeout(watchdog)
    watchdog = window.setTimeout(() => ws.close(), timeoutMs)
  }
  const wantedChannels = () => {
    const ns = cfg.namespace ?? 'chia'
    const channels = [`/${ns}/workspace/${readWorkspace() ?? cfg.personal_workspace_id}`]
    if (docId) channels.push(`/${ns}/doc/${docId}`)
    return channels
  }
  const sync = () => {
    if (!acked || ws.readyState !== WebSocket.OPEN) return
    const want = new Set(wantedChannels())
    for (const [channel, id] of subs) {
      if (want.has(channel)) continue
      ws.send(JSON.stringify({ type: 'unsubscribe', id }))
      subs.delete(channel)
    }
    for (const channel of want) {
      if (subs.has(channel)) continue
      const id = crypto.randomUUID()
      subs.set(channel, id)
      ws.send(JSON.stringify({ type: 'subscribe', id, channel, authorization: auth }))
    }
  }
  const self: Transport = {
    close: () => {
      window.clearTimeout(watchdog)
      ws.onclose = null
      ws.close()
    },
    resubscribe: sync,
  }
  ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init' }))
  ws.onmessage = (msg) => {
    let data: { type?: string; id?: string; event?: unknown; connectionTimeoutMs?: number }
    try {
      data = JSON.parse(String(msg.data))
    } catch {
      return
    }
    switch (data.type) {
      case 'connection_ack':
        acked = true
        timeoutMs = data.connectionTimeoutMs ?? timeoutMs
        alive()
        pending = wantedChannels().length
        sync()
        break
      case 'ka':
        alive()
        break
      case 'subscribe_success':
      case 'subscribe_error':
        // A refused channel (no access any more) just stays quiet; the rest still work.
        if (data.type === 'subscribe_error') for (const [channel, id] of subs) if (id === data.id) subs.delete(channel)
        if (pending > 0 && --pending === 0) ready()
        break
      case 'data': {
        const raw = Array.isArray(data.event) ? data.event : [data.event]
        for (const item of raw) {
          try {
            const event = (typeof item === 'string' ? JSON.parse(item) : item) as ChangeEvent
            if (event?.type?.startsWith('doc.')) deliver(event)
          } catch {
            /* not one of ours */
          }
        }
        break
      }
      case 'connection_error':
      case 'error':
        ws.close()
        break
    }
  }
  ws.onclose = () => {
    window.clearTimeout(watchdog)
    dropped(self)
  }
  return self
}

// ───────────── Lifecycle ─────────────

function connect() {
  window.clearTimeout(retryTimer)
  if (transport || !wanted()) return
  if (!config) {
    if (configuring) return
    configuring = true
    api.realtimeConfig().then(
      (c) => {
        config = c
        configuring = false
        connect()
      },
      () => {
        configuring = false
        hadGap = true
        if (wanted()) retryTimer = window.setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1000 * 2 ** retry++))
      },
    )
    return
  }
  transport = config.backend === 'aws_appsync' && config.realtime_url ? appSync(config) : apiSocket()
}

function disconnect() {
  window.clearTimeout(retryTimer)
  const t = transport
  transport = null
  if (t) {
    hadGap = true
    t.close()
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
  transport?.resubscribe()
}

/** Signed out: drop the connection (and the config, which names the user's workspace). */
export function stopRealtime() {
  disconnect()
  config = null
}
