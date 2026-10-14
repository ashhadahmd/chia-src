import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api, readToken, setToken, UNAUTHORIZED_EVENT, type User } from './api'
import { AuthContext } from './useAuth'

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [ready, setReady] = useState(() => readToken() === null)

  const logout = useCallback(() => {
    setToken(null)
    setUser(null)
  }, [])

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
