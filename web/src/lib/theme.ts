import { useEffect, useState } from 'react'

export type ThemePreference = 'system' | 'light' | 'dark'
type Resolved = 'light' | 'dark'
const KEY = 'chia.theme'
const FADE_MS = 700

function readPreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(KEY)
    return stored === 'light' || stored === 'dark' ? stored : 'system'
  } catch {
    return 'system'
  }
}

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)')
const resolve = (p: ThemePreference): Resolved => (p === 'system' ? (darkQuery().matches ? 'dark' : 'light') : p)

/**
 * Applies a theme with a slow cross-fade. View Transitions snapshot the whole page and blend
 * old into new; browsers without them fall back to transitioning every colour property.
 */
export function applyTheme(next: Resolved, animate = true) {
  const root = document.documentElement
  if (root.dataset.theme === next) return
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (!animate || reduced) {
    root.dataset.theme = next
    return
  }
  if (document.startViewTransition) {
    document.startViewTransition(() => {
      root.dataset.theme = next
    })
    return
  }
  root.classList.add('theme-fade')
  root.dataset.theme = next
  window.setTimeout(() => root.classList.remove('theme-fade'), FADE_MS)
}

/** System preference by default; an explicit choice is remembered. */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(readPreference)

  useEffect(() => {
    applyTheme(resolve(preference))
    try {
      if (preference === 'system') localStorage.removeItem(KEY)
      else localStorage.setItem(KEY, preference)
    } catch {
      /* non-persistent */
    }
    if (preference !== 'system') return
    const query = darkQuery()
    const follow = () => applyTheme(resolve('system'))
    query.addEventListener('change', follow)
    return () => query.removeEventListener('change', follow)
  }, [preference])

  return [preference, setPreference] as const
}
