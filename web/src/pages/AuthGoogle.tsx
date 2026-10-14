import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '../lib/useAuth'
import { peekReturnTo } from '../lib/returnTo'

/** Landing page for the Google OAuth redirect: `#token=...` signs in, `#error=...` reports back. */
export default function AuthGoogle() {
  const { user, ready, loginWithToken } = useAuth()
  const navigate = useNavigate()
  const handled = useRef(false)

  useEffect(() => {
    if (!ready || handled.current) return
    handled.current = true
    const params = new URLSearchParams(window.location.hash.slice(1))
    history.replaceState(null, '', window.location.pathname) // keep the token out of history
    const token = params.get('token')
    const error = params.get('error') ?? undefined
    if (token) {
      loginWithToken(token).then(
        () => navigate(peekReturnTo() ?? '/', { replace: true }),
        () => navigate('/login', { replace: true, state: { error: 'Google sign-in failed, try again' } }),
      )
    } else {
      navigate(user ? '/' : '/login', { replace: true, state: { error } })
    }
  }, [ready, user, loginWithToken, navigate])

  return <div className="boot" aria-busy="true" />
}
