import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/** Renders above the page (tooltips, popovers, dialogs). */
export function Float({ children }: { children: ReactNode }) {
  return createPortal(children, document.body)
}
