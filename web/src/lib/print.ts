/** Printing, which is also how Chia makes PDFs: the browser's "Save as PDF" gives a vector PDF
    for free, with no server work. Decks print one 16:9 landscape page per slide, sheets on
    landscape paper; docs set up their own pages (DocEditor: the doc's paper size, real page
    breaks). The @page rule is in place while the document is open, so Ctrl+P prints the same
    way as the menu. */

import { useEffect } from 'react'
import type { DocKind } from './api'

const PAGE_RULES: Partial<Record<DocKind, string>> = {
  slides: '@page { size: 13.333in 7.5in; margin: 0; }',
  sheet: '@page { size: letter landscape; margin: 0.5in; }',
}

export function usePrintSetup(kind: DocKind | undefined) {
  useEffect(() => {
    const rule = kind && PAGE_RULES[kind]
    if (!rule) return
    const style = document.createElement('style')
    style.textContent = rule
    document.head.append(style)
    return () => style.remove()
  }, [kind])
}

export function printNow() {
  window.print()
}
