import { ArrowRight, CircleNotch, Eye, EyeSlash } from '@phosphor-icons/react'
import { AnimatePresence, motion } from 'motion/react'
import { useEffect, useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import Brand from '../components/Brand'
import GoogleMark from '../components/GoogleMark'
import ThemeSwitch from '../components/ThemeSwitch'
import { useAuth } from '../lib/useAuth'
import { softSpring } from '../lib/kinds'
import { api, googleSignInUrl } from '../lib/api'
import { peekReturnTo } from '../lib/returnTo'

export default function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const location = useLocation()
  const [error, setError] = useState<string | null>((location.state as { error?: string } | null)?.error ?? null)
  const [google, setGoogle] = useState<boolean | null>(null)

  useEffect(() => {
    api.providers().then((p) => setGoogle(p.google), () => setGoogle(false))
  }, [])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(identifier.trim(), password)
      navigate(peekReturnTo() ?? '/', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <div className="login-theme">
        <ThemeSwitch />
      </div>
      <motion.form
        className="login-card"
        onSubmit={submit}
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={softSpring}
      >
        <Brand size={34} />
        <div>
          <h1 className="login-title">Welcome back</h1>
          <p className="login-sub">Your docs, sheets and slides — gathered in one quiet place.</p>
        </div>

        <label className="field">
          <span className="field-label">Username or email</span>
          <input
            className="input"
            autoComplete="username"
            autoFocus
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="you@example.com"
          />
        </label>

        <label className="field">
          <span className="field-label">Password</span>
          <span className="input-wrap">
            <input
              className="input"
              type={reveal ? 'text' : 'password'}
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
            <button
              type="button"
              className="input-adorn"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? 'Hide password' : 'Show password'}
            >
              {reveal ? <EyeSlash /> : <Eye />}
            </button>
          </span>
        </label>

        <AnimatePresence>
          {error && (
            <motion.p
              className="form-error"
              role="alert"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
            >
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        <motion.button className="btn btn-primary btn-block" whileTap={{ scale: 0.97 }} disabled={busy}>
          {busy ? <CircleNotch className="spin" /> : <>Sign in <ArrowRight weight="bold" size={18} /></>}
        </motion.button>

        <div className="or" aria-hidden="true">
          <span>or</span>
        </div>

        <motion.a
          className="btn btn-google btn-block"
          href={google ? googleSignInUrl : undefined}
          aria-disabled={!google}
          whileTap={google ? { scale: 0.97 } : undefined}
          title={google === false ? 'Google sign-in needs OAuth keys on the server' : undefined}
        >
          <GoogleMark /> Continue with Google
        </motion.a>
        {google === false && <p className="login-hint">Google sign-in isn’t set up on this server yet.</p>}
      </motion.form>
    </main>
  )
}
