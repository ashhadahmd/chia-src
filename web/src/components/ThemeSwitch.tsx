import { Desktop, Moon, Sun } from '@phosphor-icons/react'
import { motion } from 'motion/react'
import { useTheme, type ThemePreference } from '../lib/theme'

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'system', label: 'System', icon: Desktop },
  { value: 'dark', label: 'Dark', icon: Moon },
]

export default function ThemeSwitch() {
  const [preference, setPreference] = useTheme()
  return (
    <div className="segmented" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ value, label, icon: Icon }) => {
        const active = preference === value
        return (
          <button
            key={value}
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            className="segmented-item"
            data-active={active}
            onClick={() => setPreference(value)}
          >
            {active && <motion.span layoutId="theme-pill" className="segmented-pill" />}
            <Icon size={16} weight={active ? 'fill' : 'regular'} />
          </button>
        )
      })}
    </div>
  )
}
