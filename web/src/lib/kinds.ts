import { FileText, PresentationChart, Table, type Icon } from '@phosphor-icons/react'
import type { DocKind } from './api'

export const KINDS: Record<DocKind, { label: string; plural: string; icon: Icon; hint: string }> = {
  doc: { label: 'Doc', plural: 'Docs', icon: FileText, hint: 'Long-form writing and notes' },
  sheet: { label: 'Sheet', plural: 'Sheets', icon: Table, hint: 'Rows, columns and numbers' },
  slides: { label: 'Slides', plural: 'Slides', icon: PresentationChart, hint: 'A deck to present' },
}

export const KIND_ORDER: DocKind[] = ['doc', 'sheet', 'slides']

export const spring = { type: 'spring', stiffness: 420, damping: 30, mass: 0.8 } as const
export const softSpring = { type: 'spring', stiffness: 260, damping: 26 } as const
