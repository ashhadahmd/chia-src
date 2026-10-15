import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, readToken, setToken, UNAUTHORIZED_EVENT, type User } from './api'
import { forgetLocalUser, setLocalUser } from './localStore'
import { flushOutbox } from './outbox'
import { stopRealtime } from './realtime'
import { loadWorkspaces, resetWorkspaces } from './workspaces'
import { AuthContext } from './useAuth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(() => readToken() === null)

  const logout = useCallback(() => {
    setToken(null)
    stopRealtime()
    resetWorkspaces()
    // Signing out leaves nothing of this account on the device (shared computers).
    setUser((u) => {
      if (u) forgetLocalUser(u.id)
      return null
    })
  }, [])

  // The local cache belongs to whoever is signed in. Chosen while rendering (idempotent), since
  // pages read it in their own effects, which run before this provider's.
  setLocalUser(user?.id ?? null)

  // Unsent offline edits go out on connect and whenever the network or the tab comes back.
  useEffect(() => {
    if (!user) return
    void loadWorkspaces()
    void flushOutbox()
    const flush = () => {
      if (!document.hidden) void flushOutbox()
    }
    window.addEventListener('online', flush)
    document.addEventListener('visibilitychange', flush)
    return () => {
      window.removeEventListener('online', flush)
      document.removeEventListener('visibilitychange', flush)
    }
  }, [user])

  useEffect(() => {
    if (readToken()) api.me().then(setUser, () => setToken(null)).finally(() => setReady(true))
    window.addEventListener(UNAUTHORIZED_EVENT, logout)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, logout)
  }, [logout])

  const loginWithToken = useCallback(async (token: string) => {
    setToken(token)
    try {
      setUser(await api.me())
    } catch (err) {
      setToken(null)
      throw err
    }
  }, [])

  const login = useCallback(
    async (identifier: string, password: string) => loginWithToken((await api.login(identifier, password)).access_token),
    [loginWithToken],
  )

  return <AuthContext.Provider value={{ user, ready, login, loginWithToken, logout }}>{children}</AuthContext.Provider>
}
