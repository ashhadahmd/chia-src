import { CaretDown, DownloadSimple, FileDoc, FilePdf, FilePpt, FileXls, Printer, type Icon } from '@phosphor-icons/react'
import { useState } from 'react'
import type { DocKind, ExportFormat } from '../lib/api'
import { GoogleAppIcon } from './BrandIcons'
import { Popover } from './EditorUI'
import { useTooltip } from './useTooltip'
import GoogleMark from './GoogleMark'

const PDF_BACKGROUNDS = [
  { value: '#F7F4ED', label: 'Oat paper' },
  { value: '#FFFFFF', label: 'White' },
  { value: '#EFE6D6', label: 'Sand' },
  { value: '#E6EBDF', label: 'Sage mist' },
  { value: '#1A1916', label: 'Espresso' },
]

/** The Office file each kind downloads as, in that app's colour (see .export-icon[data-app]). */
const OFFICE: Record<DocKind, { format: ExportFormat; app: string; icon: Icon; label: string; hint: string }> = {
  doc: { format: 'docx', app: 'word', icon: FileDoc, label: 'Word document', hint: '.docx for Microsoft Word' },
  sheet: { format: 'xlsx', app: 'excel', icon: FileXls, label: 'Excel workbook', hint: '.xlsx for Microsoft Excel' },
  slides: { format: 'pptx', app: 'powerpoint', icon: FilePpt, label: 'PowerPoint deck', hint: '.pptx for Microsoft PowerPoint' },
}
const GOOGLE_APP: Record<DocKind, string> = { doc: 'Google Docs', sheet: 'Google Sheets', slides: 'Google Slides' }

export interface DocActions {
  /** Print, or "Save as PDF" in the print dialog: made in the browser, instantly. */
  print: () => void
  exportFile: (format: ExportFormat, background?: string) => Promise<void>
  exportGoogle: (() => Promise<void>) | null // null when Google is not connected
}

export default function ExportMenu({ kind, actions }: { kind: DocKind; actions: DocActions }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const office = OFFICE[kind]
  const google = GOOGLE_APP[kind]
  const { bind, node } = useTooltip({
    label: 'Export',
    hint: kind === 'doc' ? 'Save as PDF or Word, or open in Google Docs' : `Save as PDF, download for ${office.label.split(' ')[0]}, or open in ${google}`,
  })
  const run = async (key: string, fn: () => Promise<void>, close: () => void) => {
    setBusy(key)
    setError(null)
    try {
      await fn()
      close()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setBusy(null)
    }
  }
  return (
    <Popover
      align="right"
      trigger={(open, toggle) => (
        <>
          <button type="button" className="btn btn-primary btn-sm export-btn" aria-expanded={open} aria-label="Export" {...bind} onClick={(e) => toggle(e.currentTarget)}>
            <DownloadSimple size={16} weight="bold" /> <span className="export-btn-label">Export</span> <CaretDown size={12} weight="bold" />
          </button>
          {node}
        </>
      )}
    >
      {(close) => (
        <div className="export-menu">
          <button
            className="popover-item"
            disabled={busy !== null}
            onClick={() => {
              close()
              // After the menu has gone, so it isn't in the printout.
              requestAnimationFrame(() => actions.print())
            }}
          >
            <span className="popover-icon export-icon" data-app="pdf">
              <FilePdf weight="fill" />
            </span>
            <span>
              <span className="popover-label">PDF</span>
              <span className="popover-hint">
                <Printer size={12} /> Print, or choose Save as PDF
              </span>
            </span>
          </button>
          {kind === 'doc' && (
            <div className="export-group">
              <span className="export-title">
                <FilePdf size={18} weight="fill" /> PDF on coloured paper
              </span>
              <span className="export-hint">Made on the server; pick a page colour</span>
              <div className="export-swatches">
                {PDF_BACKGROUNDS.map((bg) => (
                  <button
                    key={bg.value}
                    className="export-swatch"
                    style={{ background: bg.value }}
                    title={bg.label}
                    aria-label={`PDF on ${bg.label}`}
                    disabled={busy !== null}
                    data-busy={busy === bg.value || undefined}
                    onClick={() => run(bg.value, () => actions.exportFile('pdf', bg.value), close)}
                  />
                ))}
              </div>
            </div>
          )}
          <button className="popover-item" disabled={busy !== null} onClick={() => run(office.format, () => actions.exportFile(office.format), close)}>
            <span className="popover-icon export-icon" data-app={office.app}>
              <office.icon weight="fill" />
            </span>
            <span>
              <span className="popover-label">{office.label}</span>
              <span className="popover-hint">{busy === office.format ? 'Preparing…' : office.hint}</span>
            </span>
          </button>
          <button
            className="popover-item"
            disabled={busy !== null || !actions.exportGoogle}
            onClick={() => actions.exportGoogle && run('google', actions.exportGoogle, close)}
          >
            {/* Not connected: Google's G, for "sign in with Google". Connected: the editor it opens in. */}
            <span className="popover-icon export-icon" data-app="google">
              {actions.exportGoogle ? <GoogleAppIcon kind={kind} size={24} /> : <GoogleMark size={20} />}
            </span>
            <span>
              <span className="popover-label">{google}</span>
              <span className="popover-hint">{busy === 'google' ? 'Opening…' : actions.exportGoogle ? 'Opens your Drive copy' : 'Connect Google to enable'}</span>
            </span>
          </button>
          {busy && kind === 'doc' && busy.startsWith('#') && <p className="export-status">Preparing…</p>}
          {error && <p className="form-error export-status">{error}</p>}
        </div>
      )}
    </Popover>
  )
}
