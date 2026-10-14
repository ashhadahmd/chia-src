/* Product marks for export targets. The Google editors share one page shape: a sheet with a
   folded corner in the product colour, carrying that product's white glyph. */
import type { ReactNode } from 'react'
import type { DocKind } from '../lib/api'

const PAGE = 'M6.5 1.5h8.25L20 6.75V21a1.5 1.5 0 0 1-1.5 1.5h-12A1.5 1.5 0 0 1 5 21V3a1.5 1.5 0 0 1 1.5-1.5z'
const FOLD = 'M14.75 1.5v4.25a1 1 0 0 0 1 1H20z'

const GOOGLE_APPS: Record<DocKind, { page: string; fold: string; glyph: ReactNode }> = {
  doc: {
    page: '#4285F4',
    fold: '#A1C2FA',
    glyph: (
      <g fill="#fff">
        <rect x="8" y="10.5" width="9" height="1.4" rx=".4" />
        <rect x="8" y="13.4" width="9" height="1.4" rx=".4" />
        <rect x="8" y="16.3" width="6" height="1.4" rx=".4" />
      </g>
    ),
  },
  sheet: {
    page: '#0F9D58',
    fold: '#87CEAC',
    glyph: (
      <>
        <rect x="8" y="10" width="9" height="8.5" rx=".6" fill="#fff" />
        <g fill="#0F9D58">
          <rect x="11.4" y="10" width=".9" height="8.5" />
          <rect x="8" y="12.6" width="9" height=".9" />
          <rect x="8" y="15.4" width="9" height=".9" />
        </g>
      </>
    ),
  },
  slides: {
    page: '#F4B400',
    fold: '#FADA80',
    glyph: (
      <>
        <rect x="7.6" y="10.6" width="9.8" height="7" rx=".7" fill="#fff" />
        <rect x="9" y="12" width="7" height="4.2" rx=".3" fill="#F4B400" />
      </>
    ),
  },
}

/** Google Docs, Sheets or Slides mark. */
export function GoogleAppIcon({ kind, size = 22 }: { kind: DocKind; size?: number }) {
  const app = GOOGLE_APPS[kind]
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PAGE} fill={app.page} />
      <path d={FOLD} fill={app.fold} />
      {app.glyph}
    </svg>
  )
}
