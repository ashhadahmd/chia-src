import { MotionConfig } from 'motion/react'
import { IconContext } from '@phosphor-icons/react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { useEffect, type ReactNode } from 'react'
import { clearReturnTo, peekReturnTo, saveReturnTo } from './lib/returnTo'
import { AuthProvider } from './lib/auth'
import { useAuth } from './lib/useAuth'
import { spring } from './lib/kinds'
import Login from './pages/Login'
import Library from './pages/Library'
import Editor from './pages/Editor'
import AuthGoogle from './pages/AuthGoogle'
import './App.css'

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth()
  const location = useLocation()
  useEffect(() => {
    if (user) clearReturnTo() // arrived where sign-in was meant to lead
  }, [user])
  if (!ready) return <div className="boot" aria-busy="true" />
  if (!user) {
    // Remember the page (and #passage) so sign-in, including via Google, returns here.
    if (location.pathname !== '/') saveReturnTo(location.pathname + location.search + location.hash)
    return <Navigate to="/login" replace />
  }
  return children
}

function GuestOnly({ children }: { children: ReactNode }) {
  const { user, ready } = useAuth()
  if (!ready) return <div className="boot" aria-busy="true" />
  return user ? <Navigate to={peekReturnTo() ?? '/'} replace /> : children
}

export default function App() {
  return (
    <MotionConfig transition={spring} reducedMotion="user">
      <IconContext.Provider value={{ size: 20, weight: 'regular' }}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<GuestOnly><Login /></GuestOnly>} />
            <Route path="/auth/google" element={<AuthGoogle />} />
            <Route path="/" element={<RequireAuth><Library /></RequireAuth>} />
            <Route path="/d/:id" element={<RequireAuth><Editor /></RequireAuth>} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </IconContext.Provider>
    </MotionConfig>
  )
}
