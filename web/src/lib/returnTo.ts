/** Where to send the user after signing in (e.g. a shared link to a passage in a doc). */
const KEY = 'chia.returnTo'

export function saveReturnTo(path: string) {
  try {
    sessionStorage.setItem(KEY, path)
  } catch {
    /* storage unavailable: land on the library instead */
  }
}

/** Same-origin paths only, so a crafted value can't send people off-site. */
export function peekReturnTo(): string | null {
  try {
    const path = sessionStorage.getItem(KEY)
    return path && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/login') ? path : null
  } catch {
    return null
  }
}

export function clearReturnTo() {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    /* nothing to clear */
  }
}
