import { Robot, SquaresFour, type Icon } from '@phosphor-icons/react'
import { useSearchParams } from 'react-router'
import type { DocSummary } from './api'
import { KIND_ORDER, KINDS } from './kinds'

export type Filter = 'all' | 'mcp' | DocSummary['kind']

export const FILTERS: { value: Filter; label: string; icon: Icon }[] = [
  { value: 'all', label: 'Everything', icon: SquaresFour },
  ...KIND_ORDER.map((k) => ({ value: k as Filter, label: KINDS[k].plural, icon: KINDS[k].icon })),
  { value: 'mcp', label: 'Made by AI', icon: Robot },
]

export function useFilter(): [Filter, (f: Filter) => void] {
  const [params, setParams] = useSearchParams()
  const raw = params.get('show')
  const filter = FILTERS.some((i) => i.value === raw) ? (raw as Filter) : 'all'
  return [filter, (f) => setParams(f === 'all' ? {} : { show: f }, { replace: true })]
}
