import { CloudCheck, CloudSlash } from '@phosphor-icons/react'
import { useEffect, useState } from 'react'
import { api, type GoogleStatus } from '../lib/api'
import GoogleMark from './GoogleMark'

/** Sidebar control for Google Drive backup. */
export default function DriveCard() {
  const [status, setStatus] = useState<GoogleStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.googleStatus().then(setStatus, () => setStatus(null))
  }, [])

  if (!status) return null

  if (!status.configured)
    return (
      <div className="drive-card" data-state="off">
        <CloudSlash size={18} />
        <span className="drive-text">
          <span className="drive-title">Drive backup unavailable</span>
          <span className="drive-sub">Google keys not set on the server</span>
        </span>
      </div>
    )

  if (status.connected)
    return (
      <div className="drive-card" data-state="on">
        <CloudCheck size={18} weight="fill" />
        <span className="drive-text">
          <span className="drive-title">Backing up to Drive</span>
          <span className="drive-sub">{status.email}</span>
        </span>
        <button
          className="drive-action"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm('Stop backing up to Google Drive? Existing backups stay in your Drive.')) return
            setBusy(true)
            await api.googleDisconnect().catch(() => {})
            setStatus({ ...status, connected: false, email: null })
            setBusy(false)
          }}
        >
          Stop
        </button>
      </div>
    )

  return (
    <button
      className="drive-card drive-connect"
      disabled={busy}
      onClick={async () => {
        setBusy(true)
        try {
          window.location.href = (await api.googleConnect()).auth_url
        } catch {
          setBusy(false)
        }
      }}
    >
      <GoogleMark size={18} />
      <span className="drive-text">
        <span className="drive-title">Back up to Google Drive</span>
        <span className="drive-sub">Keeps a copy of every document</span>
      </span>
    </button>
  )
}
